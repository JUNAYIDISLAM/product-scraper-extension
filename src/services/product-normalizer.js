/**
 * Converts raw adapter output into the common product data model, and
 * re-validates products before export.
 *
 * Common product model (one CSV row):
 *   platform      'walmart' | 'amazon' | 'target' | 'bestbuy' | 'ebay'
 *   product_id    native id (ASIN, item id, TCIN, SKU...) or the product URL
 *   product_name  cleaned visible product title
 *   price         '24.97', '12.99 - 24.99' or '' when no price is shown
 *   currency      ISO 4217 code or '' when it cannot be determined
 *   product_url   canonical HTTPS URL on the platform's own domain
 *   image_url     best main-image URL that will be downloaded
 *   image         relative path inside the ZIP (filled in during export)
 *
 * Internal fields (not exported to CSV):
 *   image_candidates  ordered list of image URLs to try, best first
 *   thumbnail_url     smaller image for the popup preview
 *   sponsored         true for ads / sponsored placements
 *   warnings          per-product notes shown in the popup
 */
import { getPlatform, isAllowedImageUrl, isPlatformPageUrl } from '../adapters/platforms.js';
import { parseUrl } from '../utils/url.js';
import { cleanText, truncate } from '../utils/text.js';

export const CSV_COLUMNS = Object.freeze([
  'platform',
  'product_id',
  'product_name',
  'price',
  'currency',
  'product_url',
  'image_url',
  'image',
]);

export const PRODUCT_LIMIT_OPTIONS = Object.freeze([10, 25, 50, 100]);
export const DEFAULT_PRODUCT_LIMIT = 25;
export const MAX_EXPORT_PRODUCTS = 100;
export const MAX_NAME_LENGTH = 500;
export const MAX_URL_LENGTH = 2048;
export const MAX_IMAGE_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

// Longest symbols first so "US $" wins over "$".
const SYMBOL_TO_CURRENCY = [
  ['US $', 'USD'], ['US$', 'USD'], ['USD $', 'USD'],
  ['CA $', 'CAD'], ['CA$', 'CAD'], ['C $', 'CAD'], ['C$', 'CAD'],
  ['AU $', 'AUD'], ['AU$', 'AUD'], ['A $', 'AUD'], ['A$', 'AUD'],
  ['NZ$', 'NZD'], ['HK$', 'HKD'], ['MX$', 'MXN'], ['R$', 'BRL'], ['S$', 'SGD'],
  ['$', null], // resolved to the platform's default currency
  ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₹', 'INR'], ['₩', 'KRW'],
];
const ISO_CODES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'INR', 'MXN', 'BRL',
  'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'HKD', 'SGD', 'KRW', 'ILS', 'ZAR', 'TRY',
];
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'HUF']);

// Symbols that start with a letter ("C $", "US$") must not be preceded by
// another letter, otherwise "music $5" would be read as Canadian dollars.
const symbolPattern = (symbol) => {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s?');
  return /^[A-Z]/.test(symbol) ? `(?<![A-Za-z])${escaped}` : escaped;
};
const CURRENCY_ALTERNATION = [
  ...SYMBOL_TO_CURRENCY.map(([symbol]) => symbolPattern(symbol)),
  ...ISO_CODES.map((code) => `\\b${code}\\b`),
].join('|');
const NUMBER = '\\d+(?:[.,]\\d+)*';
// "$24.97", "US $1,299.00", "EUR 12,34" (prefix) or "12,34 €" / "12.34 EUR" (suffix).
const MONEY_REGEX = new RegExp(
  `(${CURRENCY_ALTERNATION})\\s*(${NUMBER})|(${NUMBER})\\s*(€|\\b(?:${ISO_CODES.join('|')})\\b)`,
  'g',
);
const RANGE_SEPARATOR = /^\s*(?:-|–|—|to)\s*$/i;

function currencyFromToken(token, defaultCurrency) {
  const compact = token.replace(/\s+/g, ' ').trim().toUpperCase();
  const iso = ISO_CODES.find((code) => code === compact);
  if (iso) return iso;
  for (const [symbol, code] of SYMBOL_TO_CURRENCY) {
    if (symbol.toUpperCase().replace(/\s/g, '') === compact.replace(/\s/g, '')) return code ?? defaultCurrency ?? '';
  }
  return defaultCurrency ?? '';
}

/**
 * Parses "1,299.99", "12,34", "1.299,00" into `{ integer, fraction }` digit strings.
 * Returns null for anything that is not a well-formed number.
 */
function parseAmountDigits(raw) {
  const text = String(raw);
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  let decimal = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? '.' : ',';
  } else if (lastComma >= 0) {
    const digitsAfter = text.length - lastComma - 1;
    decimal = text.split(',').length === 2 && digitsAfter <= 2 ? ',' : null; // "12,34" vs "1,299"
  } else if (lastDot >= 0) {
    decimal = text.split('.').length === 2 ? '.' : null; // "12.34" vs "1.299.000"
  }
  let integer = text;
  let fraction = '';
  if (decimal) {
    const index = text.lastIndexOf(decimal);
    integer = text.slice(0, index);
    fraction = text.slice(index + 1);
  }
  integer = integer.replace(/[.,]/g, '');
  if (!/^\d+$/.test(integer) || (fraction && !/^\d+$/.test(fraction))) return null;
  return { integer: integer.replace(/^0+(?=\d)/, ''), fraction };
}

function formatAmount({ integer, fraction }, currency) {
  if (ZERO_DECIMAL_CURRENCIES.has(currency) && !fraction) return integer;
  if (!fraction) return `${integer}.00`;
  return `${integer}.${fraction.length === 1 ? `${fraction}0` : fraction}`;
}

/**
 * Extracts a price from visible text. Only text that contains a currency
 * marker is accepted, so ratings ("4.5 out of 5") or counts are never
 * mistaken for prices.
 *
 * @returns {{ price: string, currency: string }} price is '' when none found.
 */
export function parsePrice(text, defaultCurrency = '') {
  const source = cleanText(text);
  if (!source) return { price: '', currency: '' };
  const tokens = [];
  MONEY_REGEX.lastIndex = 0;
  let match;
  while ((match = MONEY_REGEX.exec(source)) && tokens.length < 3) {
    const symbol = match[1] ?? match[4];
    const digits = parseAmountDigits(match[2] ?? match[3]);
    if (!digits) continue;
    const currency = currencyFromToken(symbol, defaultCurrency);
    tokens.push({ currency, digits, start: match.index, end: match.index + match[0].length });
  }
  if (!tokens.length) return { price: '', currency: '' };
  const [first, second] = tokens;
  const firstAmount = formatAmount(first.digits, first.currency);
  if (second && second.currency === first.currency && RANGE_SEPARATOR.test(source.slice(first.end, second.start))) {
    return { price: `${firstAmount} - ${formatAmount(second.digits, second.currency)}`, currency: first.currency };
  }
  return { price: firstAmount, currency: first.currency };
}

/** Formats a numeric price from structured data (e.g. JSON) as a price string. */
export function priceFromNumber(amount, currency = '') {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) return { price: '', currency: '' };
  const code = /^[A-Z]{3}$/.test(String(currency)) ? String(currency) : '';
  const price = ZERO_DECIMAL_CURRENCIES.has(code) ? String(Math.round(value)) : value.toFixed(2);
  return { price, currency: code };
}

const PRICE_FORMAT = /^\d{1,10}(?:\.\d{1,4})?(?: - \d{1,10}(?:\.\d{1,4})?)?$/;

// ---------------------------------------------------------------------------
// Identifiers and URLs
// ---------------------------------------------------------------------------

/** Native product ids: letters, digits and a few separators, max 100 characters. */
export function sanitizeProductId(value) {
  const id = cleanText(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(id) ? id : '';
}

/**
 * Returns an HTTPS URL on the platform's own domain without fragment or
 * credentials, or '' when the URL is missing, malformed or off-platform.
 */
export function normalizeProductUrl(value, platformId) {
  const parsed = parseUrl(value);
  if (!parsed) return '';
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  const href = parsed.href;
  return href.length <= MAX_URL_LENGTH && isPlatformPageUrl(href, platformId) ? href : '';
}

function filterImageCandidates(candidates, platformId) {
  const accepted = [];
  const rejectedHosts = new Set();
  for (const value of Array.isArray(candidates) ? candidates : []) {
    const parsed = parseUrl(value);
    if (!parsed) continue;
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    const href = parsed.href;
    if (href.length > MAX_URL_LENGTH) continue;
    if (!isAllowedImageUrl(href, platformId)) {
      if (parsed.protocol === 'https:') rejectedHosts.add(parsed.hostname);
      continue;
    }
    if (!accepted.includes(href)) accepted.push(href);
    if (accepted.length >= MAX_IMAGE_CANDIDATES) break;
  }
  return { accepted, rejectedHosts: [...rejectedHosts] };
}

export function productKey(product) {
  return `${product.platform}:${product.product_id}`;
}

// ---------------------------------------------------------------------------
// Normalisation of scan results
// ---------------------------------------------------------------------------

function skip(reason, raw) {
  const name = truncate(cleanText(raw?.name), 120);
  const id = cleanText(raw?.productId);
  return { skip: { reason, name, productId: id } };
}

/**
 * Normalises one raw card from an adapter.
 *
 * @param {import('../adapters/base-adapter.js').RawCard} raw
 * @param {{ id: string, name: string, defaultCurrency: string }} platform
 * @returns {{ product: object } | { skip: { reason: string, name: string, productId: string } }}
 */
export function normalizeProduct(raw, platform) {
  if (!raw || typeof raw !== 'object') return skip('Card data could not be read', raw);

  const name = truncate(cleanText(raw.name), MAX_NAME_LENGTH);
  const productUrl = normalizeProductUrl(raw.url, platform.id);
  const productId = sanitizeProductId(raw.productId);

  if (!name) return skip('Missing product name', raw);
  if (!productId && !productUrl) {
    return skip(raw.url ? `Product link does not point to ${platform.name}` : 'Missing product ID and product link', raw);
  }
  if (raw.url && !productUrl) return skip(`Product link does not point to ${platform.name}`, raw);

  // Prefer the visible price text; fall back to a structured numeric price.
  let { price, currency } = parsePrice(raw.priceText, platform.defaultCurrency);
  if (!price && raw.priceAmount != null) {
    ({ price, currency } = priceFromNumber(raw.priceAmount, raw.currency || platform.defaultCurrency));
  }

  const warnings = [];
  const { accepted, rejectedHosts } = filterImageCandidates(raw.imageCandidates, platform.id);
  if (rejectedHosts.length) warnings.push(`Image host not allowed: ${rejectedHosts.join(', ')}`);
  if (!accepted.length) warnings.push('No main image found on the product card');
  if (!price) warnings.push('No price shown on the product card');

  const thumbnail = filterImageCandidates([raw.thumbnailUrl], platform.id).accepted[0] || accepted[accepted.length - 1] || '';

  return {
    product: {
      platform: platform.id,
      product_id: productId || productUrl,
      product_name: name,
      price,
      currency: price ? currency : '',
      product_url: productUrl,
      image_url: accepted[0] || '',
      image: '',
      image_candidates: accepted,
      thumbnail_url: thumbnail,
      sponsored: Boolean(raw.sponsored),
      warnings,
    },
  };
}

/**
 * Removes duplicates (same platform + product id) keeping the first occurrence.
 * @returns {{ unique: object[], duplicates: object[] }}
 */
export function dedupeProducts(products) {
  const seen = new Map();
  const unique = [];
  const duplicates = [];
  for (const product of products) {
    const key = productKey(product);
    if (seen.has(key)) {
      duplicates.push(product);
    } else {
      seen.set(key, product);
      unique.push(product);
    }
  }
  return { unique, duplicates };
}

export function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_PRODUCT_LIMIT;
  return Math.min(value, MAX_EXPORT_PRODUCTS);
}

function summarizeSkipped(skipped) {
  const summary = {};
  for (const entry of skipped) summary[entry.reason] = (summary[entry.reason] || 0) + 1;
  return summary;
}

/**
 * Normalises a whole adapter extraction: validates every card, removes
 * duplicates, filters sponsored listings (unless requested) and applies the limit.
 */
export function normalizeScanResult(extraction, platform, { limit = DEFAULT_PRODUCT_LIMIT, includeSponsored = false } = {}) {
  const cards = Array.isArray(extraction?.cards) ? extraction.cards : [];
  const skipped = Array.isArray(extraction?.skipped) ? [...extraction.skipped] : [];
  const warnings = Array.isArray(extraction?.warnings) ? [...extraction.warnings] : [];

  const valid = [];
  for (const raw of cards) {
    const result = normalizeProduct(raw, platform);
    if (result.skip) skipped.push(result.skip);
    else valid.push(result.product);
  }

  const { unique, duplicates } = dedupeProducts(valid);
  for (const dup of duplicates) {
    skipped.push({ reason: 'Duplicate of a product already listed', name: truncate(dup.product_name, 120), productId: dup.product_id });
  }

  let eligible = unique;
  const sponsored = unique.filter((p) => p.sponsored);
  if (!includeSponsored && sponsored.length) {
    eligible = unique.filter((p) => !p.sponsored);
    for (const ad of sponsored) {
      skipped.push({ reason: 'Sponsored listing (enable "Include sponsored" to keep it)', name: truncate(ad.product_name, 120), productId: ad.product_id });
    }
  }

  const max = normalizeLimit(limit);
  return {
    cardsFound: cards.length + (Array.isArray(extraction?.skipped) ? extraction.skipped.length : 0),
    detectedCount: eligible.length,
    sponsoredCount: sponsored.length,
    limit: max,
    products: eligible.slice(0, max),
    skipped,
    skippedSummary: summarizeSkipped(skipped),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Re-validation before export
// ---------------------------------------------------------------------------

/**
 * Strictly re-validates a product received from another extension context
 * before it is exported. Page data is untrusted, so every field is checked
 * again here (types, lengths, URL hosts) instead of trusting the scan.
 *
 * @returns {object | null} a clean product, or null when it cannot be exported.
 */
export function sanitizeProductForExport(input) {
  if (!input || typeof input !== 'object') return null;
  const platform = getPlatform(input.platform);
  if (!platform) return null;

  const productName = truncate(cleanText(typeof input.product_name === 'string' ? input.product_name : ''), MAX_NAME_LENGTH);
  const productUrl = normalizeProductUrl(input.product_url, platform.id);
  const productId = sanitizeProductId(input.product_id) || normalizeProductUrl(input.product_id, platform.id);
  if (!productName || !productId) return null;

  const price = typeof input.price === 'string' && PRICE_FORMAT.test(input.price) ? input.price : '';
  const currency = price && typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency) ? input.currency : '';
  const { accepted } = filterImageCandidates(input.image_candidates, platform.id);

  return {
    platform: platform.id,
    product_id: productId,
    product_name: productName,
    price,
    currency,
    product_url: productUrl,
    image_url: accepted[0] || '',
    image: '',
    image_candidates: accepted,
  };
}
