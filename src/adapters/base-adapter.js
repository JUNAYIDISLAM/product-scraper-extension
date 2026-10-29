/**
 * Base class and shared DOM helpers for platform adapters.
 *
 * An adapter reads ONE search results document and returns raw cards. Every
 * field of a raw card is read from inside the same product card element, so
 * the name, price, link and image always belong to the same product. Adapters
 * never pair data by array position.
 *
 * @typedef {object} RawCard
 * @property {string} [productId]       native id (ASIN, item id, TCIN, SKU, ...)
 * @property {string} [name]            visible product title
 * @property {string} [url]             absolute product URL on the platform
 * @property {string} [priceText]       visible price text, e.g. "$24.97" or "$10 - $20"
 * @property {number} [priceAmount]     numeric price from structured data (fallback)
 * @property {string} [currency]        ISO currency from structured data (fallback)
 * @property {string[]} [imageCandidates] main image URLs, best quality first
 * @property {string} [thumbnailUrl]    small image for the popup preview
 * @property {boolean} [sponsored]      true for ads / sponsored placements
 *
 * @typedef {object} Extraction
 * @property {RawCard[]} cards
 * @property {{ reason: string, name?: string, productId?: string }[]} skipped
 * @property {string[]} warnings
 */
import { detectPlatformFromUrl } from './platforms.js';
import { cleanText } from '../utils/text.js';
import { parseUrl, toHttpsUrl } from '../utils/url.js';

export { cleanText };

export class BaseAdapter {
  /** @param {object} platform entry from PLATFORMS */
  constructor(platform) {
    this.platform = platform;
  }

  get id() {
    return this.platform.id;
  }

  get name() {
    return this.platform.name;
  }

  matchesUrl(url) {
    return detectPlatformFromUrl(url)?.id === this.platform.id;
  }

  /**
   * 'search' for search results pages, 'listing' for category/browse pages
   * that use the same product grid, 'other' for anything else.
   */
  getPageType(_url) {
    return 'other';
  }

  /** Returns a message when the page is a CAPTCHA / bot check / access denied page, else ''. */
  detectBlockPage(doc) {
    return detectCommonBlockPage(doc, this.platform.name);
  }

  /**
   * @param {Document} doc
   * @param {{ pageUrl: string }} context
   * @returns {Extraction}
   */
  extract(_doc, _context) {
    throw new Error(`${this.constructor.name} must implement extract()`);
  }
}

// ---------------------------------------------------------------------------
// Text and attribute helpers
// ---------------------------------------------------------------------------

export function textOf(element) {
  return element ? cleanText(element.textContent) : '';
}

/** First element in `root` matching any selector, in selector priority order. */
export function firstMatch(root, selectors) {
  if (!root) return null;
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/** First non-empty text among elements matching the selectors (priority order). */
export function firstText(root, selectors) {
  if (!root) return '';
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      const text = textOf(element);
      if (text) return text;
    }
  }
  return '';
}

/** Absolute HTTPS URL of an element attribute (resolved against the page URL), or ''. */
export function absoluteUrl(value, baseUrl) {
  return toHttpsUrl(value, baseUrl);
}

/** Keeps only elements that are not inside another element of the list. */
export function outermost(elements) {
  const list = [...new Set(elements)];
  return list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
}

export function uniqueStrings(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v))];
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const PLACEHOLDER_IMAGE = /grey-pixel|transparent-pixel|blank\.gif|spacer\.gif|s_1x2\.gif|1x1\.(gif|png)|placeholder|data:image/i;

/**
 * Parses a srcset into `[{ url, value, unit }]`, largest first. Width
 * descriptors (w) rank above density descriptors (x).
 */
export function parseSrcset(srcset) {
  const results = [];
  const text = String(srcset ?? '').trim();
  if (!text) return results;
  const pattern = /(\S+?)(?:\s+(\d+(?:\.\d+)?)([wx]))?\s*(?:,\s*|$)/g;
  let match;
  while ((match = pattern.exec(text)) && match[0]) {
    results.push({ url: match[1], value: match[2] ? Number(match[2]) : 1, unit: match[3] || 'x' });
  }
  return results.sort((a, b) => (a.unit === b.unit ? b.value - a.value : a.unit === 'w' ? -1 : 1));
}

/**
 * Collects image URLs for an <img> (and its <picture> sources), best first:
 * largest srcset candidate, then lazy-load attributes, then `src`.
 * Placeholder pixels and data: URIs are dropped.
 */
export function imageUrlsFromImg(img, baseUrl) {
  if (!img) return [];
  const urls = [];
  const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
  const srcsets = [img.getAttribute('srcset'), img.getAttribute('data-srcset')];
  if (picture) for (const source of picture.querySelectorAll('source')) srcsets.push(source.getAttribute('srcset'));
  for (const srcset of srcsets) for (const candidate of parseSrcset(srcset)) urls.push(candidate.url);
  for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'data-defer-load', 'src']) {
    urls.push(img.getAttribute(attr));
  }
  return uniqueStrings(
    urls
      .filter((u) => u && !PLACEHOLDER_IMAGE.test(u))
      .map((u) => absoluteUrl(u, baseUrl))
      .filter(Boolean),
  );
}

/** The `src` the browser is showing (good enough for a small preview thumbnail). */
export function thumbnailFromImg(img, baseUrl) {
  if (!img) return '';
  const src = img.getAttribute('src');
  if (src && !PLACEHOLDER_IMAGE.test(src)) return absoluteUrl(src, baseUrl);
  return imageUrlsFromImg(img, baseUrl).at(-1) || '';
}

// ---------------------------------------------------------------------------
// Card detection helpers
// ---------------------------------------------------------------------------

/**
 * True when the card contains a short label whose whole text is "Sponsored"
 * (or "Sponsored ad"). Matching the whole label avoids false positives from
 * product titles that merely contain the word.
 */
export function hasSponsoredLabel(card) {
  if (!card) return false;
  for (const el of card.querySelectorAll('span, div, p, small, a, label')) {
    const raw = el.textContent;
    if (raw.length > 40) continue;
    if (/^\s*(sponsored|sponsored ad)\s*$/i.test(raw)) return true;
  }
  return false;
}

/**
 * Fallback card finder: groups product links by product id and climbs from
 * each link to the largest ancestor that still contains links to only that
 * one product. This keeps working when class names change, and it can never
 * merge two products into one card.
 *
 * @param {Document} doc
 * @param {string} linkSelector CSS selector for product links
 * @param {(href: string) => string} idFromHref returns '' for non-product links
 * @returns {Element[]} card elements in document order (one per product id)
 */
export function groupLinksIntoCards(doc, linkSelector, idFromHref) {
  const cards = [];
  const seen = new Set();
  const stopAt = new Set([doc.body, doc.documentElement]);
  for (const link of doc.querySelectorAll(linkSelector)) {
    const id = idFromHref(link.getAttribute('href') || '');
    if (!id || seen.has(id)) continue;
    let card = link;
    let node = link.parentElement;
    while (node && !stopAt.has(node)) {
      let foreign = false;
      for (const other of node.querySelectorAll(linkSelector)) {
        const otherId = idFromHref(other.getAttribute('href') || '');
        if (otherId && otherId !== id) {
          foreign = true;
          break;
        }
      }
      if (foreign) break;
      card = node;
      node = node.parentElement;
    }
    seen.add(id);
    cards.push(card);
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Block pages
// ---------------------------------------------------------------------------

const BLOCK_TITLE = /robot check|robot or human|are you a (robot|human)|access denied|pardon our interruption|verify you are (a )?human|security check|captcha/i;

export function detectCommonBlockPage(doc, platformName) {
  const title = cleanText(doc.title);
  const hasCaptcha = doc.querySelector(
    'form[action*="validateCaptcha"], #px-captcha, iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], #challenge-form',
  );
  if (hasCaptcha || BLOCK_TITLE.test(title)) {
    return `${platformName} is showing a verification or access-denied page ("${title || 'CAPTCHA'}"). ` +
      'Complete it yourself in this tab if you can, then search again. The extension never bypasses CAPTCHAs or access controls.';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Structured data (JSON-LD)
// ---------------------------------------------------------------------------

const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const hasType = (node, type) => asArray(node?.['@type']).some((t) => String(t).toLowerCase() === type);

function jsonLdImage(image) {
  for (const entry of asArray(image)) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof (entry.contentUrl || entry.url) === 'string') return entry.contentUrl || entry.url;
  }
  return '';
}

function jsonLdOffer(offers) {
  for (const offer of asArray(offers)) {
    if (!offer || typeof offer !== 'object') continue;
    const price = offer.price ?? offer.lowPrice;
    if (price != null && price !== '') return { price: Number(price), currency: String(offer.priceCurrency || '') };
  }
  return null;
}

/**
 * Reads schema.org Product objects from JSON-LD scripts, including products
 * nested in ItemList / @graph. Anything that is not typed as a Product is
 * ignored. Adapters use the result only to fill fields that are missing from
 * a DOM card with the same product id (see `enrichFromStructuredData`).
 */
export function readJsonLdProducts(doc) {
  const products = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node['@graph']) visit(node['@graph'], depth + 1);
    if (hasType(node, 'itemlist')) {
      for (const element of asArray(node.itemListElement)) visit(element?.item ?? element, depth + 1);
    }
    if (hasType(node, 'product')) {
      const offer = jsonLdOffer(node.offers);
      products.push({
        name: cleanText(node.name),
        url: typeof node.url === 'string' ? node.url : '',
        image: jsonLdImage(node.image),
        sku: cleanText(node.sku || node.productID || ''),
        priceAmount: offer && Number.isFinite(offer.price) ? offer.price : undefined,
        currency: offer?.currency || '',
      });
    }
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent), 0);
    } catch {
      // Invalid JSON-LD is ignored.
    }
  }
  return products;
}

/**
 * Fills missing name / price / image of DOM cards from structured products
 * with the SAME product id. Structured entries without a matching DOM card are
 * ignored, so stale or unrelated data can never add products.
 *
 * @param {RawCard[]} cards
 * @param {Map<string, Partial<RawCard> & { image?: string }>} byId
 */
export function enrichFromStructuredData(cards, byId) {
  if (!byId || byId.size === 0) return;
  for (const card of cards) {
    const data = card.productId ? byId.get(card.productId) : undefined;
    if (!data) continue;
    if (!card.name && data.name) card.name = data.name;
    if (!card.priceText && card.priceAmount == null) {
      if (data.priceText) card.priceText = data.priceText;
      else if (data.priceAmount != null) {
        card.priceAmount = data.priceAmount;
        card.currency = data.currency || card.currency;
      }
    }
    if ((!card.imageCandidates || card.imageCandidates.length === 0) && data.imageCandidates?.length) {
      card.imageCandidates = data.imageCandidates;
      card.thumbnailUrl = card.thumbnailUrl || data.imageCandidates.at(-1);
    }
    if (data.sponsored) card.sponsored = true;
  }
}

/** Builds an id -> structured product map from JSON-LD using the adapter's id function. */
export function jsonLdById(doc, idFromUrl, baseUrl, upgradeImage = (u) => u) {
  const map = new Map();
  for (const product of readJsonLdProducts(doc)) {
    const url = parseUrl(product.url, baseUrl);
    const id = (url && idFromUrl(url.href)) || '';
    if (!id || map.has(id)) continue;
    const image = absoluteUrl(product.image, baseUrl);
    map.set(id, {
      name: product.name,
      priceAmount: product.priceAmount,
      currency: product.currency,
      imageCandidates: image ? uniqueStrings([upgradeImage(image), image]) : [],
    });
  }
  return map;
}
