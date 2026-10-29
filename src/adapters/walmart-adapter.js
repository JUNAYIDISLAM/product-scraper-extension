/**
 * Walmart.com search results adapter.
 *
 * Product cards: elements with [data-item-id] (outermost only)
 *   - id:     the numeric item id from the /ip/<slug>/<id> link (the id used in
 *             public Walmart product URLs)
 *   - name:   [data-automation-id="product-title"]
 *   - price:  the screen-reader sentence inside [data-automation-id="product-price"]
 *             ("current price $24.97"). The visual price is split into spans
 *             ("$", "24", "97") without a decimal point, so it is not parsed.
 *   - image:  img[data-testid="productTileImage"]; the resize query
 *             (?odnHeight=...&odnWidth=...) is removed to get the original image.
 *   - ads:    sponsored cards link through /sp/track?...&rd=<product url>.
 *
 * Structured data: Walmart embeds search results in the Next.js
 * `__NEXT_DATA__` script. It is used ONLY to fill missing fields of DOM cards
 * with the same item id, because it can be stale after client-side navigation.
 */
import {
  BaseAdapter, textOf, firstText, imageUrlsFromImg, thumbnailFromImg, hasSponsoredLabel,
  outermost, uniqueStrings, enrichFromStructuredData, jsonLdById, absoluteUrl,
} from './base-adapter.js';
import { PLATFORMS } from './platforms.js';
import { parseUrl } from '../utils/url.js';

const CARD_SELECTOR = '[data-item-id]';
const LINK_SELECTOR = 'a[link-identifier][href], a[href*="/ip/"], a[href*="/sp/track"]';
const ITEM_ID_PATTERN = /\/ip\/(?:([^/?#]+)\/)?(\d{4,})(?:[/?#]|$)/;

/** Resolves sponsored /sp/track redirect links to the real product URL. */
export function resolveWalmartLink(href, baseUrl) {
  const url = parseUrl(href, baseUrl);
  if (!url) return null;
  if (url.pathname.startsWith('/sp/track') || (url.searchParams.has('rd') && !ITEM_ID_PATTERN.test(url.pathname))) {
    const target = parseUrl(url.searchParams.get('rd') || '', baseUrl);
    return target ? { url: target, sponsored: true } : null;
  }
  return { url, sponsored: false };
}

export function walmartItemIdFromUrl(url) {
  const parsed = typeof url === 'string' ? parseUrl(url) : url;
  return parsed?.pathname.match(ITEM_ID_PATTERN)?.[2] || '';
}

/** https://www.walmart.com/ip/<slug>/<id> without tracking parameters. */
export function canonicalWalmartUrl(url, itemId) {
  const slug = url.pathname.match(ITEM_ID_PATTERN)?.[1];
  return `${PLATFORMS.walmart.origin}/ip/${slug ? `${slug}/` : ''}${itemId}`;
}

/** Removes the resize query from i5.walmartimages.com URLs; '' when not applicable. */
export function upgradeWalmartImageUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== 'i5.walmartimages.com' || !parsed.search) return '';
  parsed.search = '';
  return parsed.href;
}

function readPrice(card) {
  const priceBlock = card.querySelector('[data-automation-id="product-price"]');
  if (!priceBlock) return '';
  for (const el of priceBlock.querySelectorAll('span, div')) {
    if (el.childElementCount > 0) continue;
    const match = textOf(el).match(/current price\s*(?:now\s*)?(.+)$/i);
    if (match) return match[1];
  }
  return '';
}

/**
 * Reads products from `__NEXT_DATA__` (props.pageProps.initialData.searchResult.itemStacks[].items[]).
 * Returns an empty map when the structure is not what we expect.
 */
export function readWalmartNextData(doc) {
  const byId = new Map();
  const script = doc.getElementById('__NEXT_DATA__');
  if (!script) return byId;
  let data;
  try {
    data = JSON.parse(script.textContent);
  } catch {
    return byId;
  }
  const stacks = data?.props?.pageProps?.initialData?.searchResult?.itemStacks;
  if (!Array.isArray(stacks)) return byId;
  for (const stack of stacks) {
    for (const item of Array.isArray(stack?.items) ? stack.items : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.__typename && item.__typename !== 'Product') continue;
      const id = String(item.usItemId ?? '');
      if (!/^\d{4,}$/.test(id) || byId.has(id)) continue;
      const image = absoluteUrl(item.imageInfo?.thumbnailUrl || item.image, PLATFORMS.walmart.origin);
      const current = item.priceInfo?.currentPrice;
      byId.set(id, {
        name: typeof item.name === 'string' ? item.name : '',
        priceText: typeof item.priceInfo?.linePrice === 'string' ? item.priceInfo.linePrice : '',
        priceAmount: typeof current?.price === 'number' ? current.price : undefined,
        currency: typeof current?.currencyUnit === 'string' ? current.currencyUnit : '',
        imageCandidates: image ? uniqueStrings([upgradeWalmartImageUrl(image), image]) : [],
        sponsored: item.isSponsoredFlag === true,
      });
    }
  }
  return byId;
}

export class WalmartAdapter extends BaseAdapter {
  constructor() {
    super(PLATFORMS.walmart);
  }

  getPageType(url) {
    const path = parseUrl(url)?.pathname || '';
    if (path === '/search' || path.startsWith('/search/')) return 'search';
    if (/^\/(browse|cp|shop)\//.test(path)) return 'listing';
    return 'other';
  }

  detectBlockPage(doc) {
    if (doc.querySelector('#px-captcha') || /robot or human/i.test(doc.title)) {
      return 'Walmart is showing its "Robot or human?" verification page. Complete it yourself in this tab if you can, then search again. The extension never bypasses verification.';
    }
    return super.detectBlockPage(doc);
  }

  extract(doc, { pageUrl }) {
    const cards = [];
    const skipped = [];
    const warnings = [];

    for (const card of outermost([...doc.querySelectorAll(CARD_SELECTOR)])) {
      const link = card.querySelector(LINK_SELECTOR);
      const resolved = link ? resolveWalmartLink(link.getAttribute('href'), pageUrl) : null;
      const name =
        firstText(card, ['[data-automation-id="product-title"]', 'a[link-identifier] span']) ||
        (card.querySelector('img[data-testid="productTileImage"]')?.getAttribute('alt') ?? '');
      if (!resolved) {
        skipped.push({ reason: 'Card has no product link', name });
        continue;
      }
      const itemId = walmartItemIdFromUrl(resolved.url) || (/^\d{4,}$/.test(link.getAttribute('link-identifier') || '') ? link.getAttribute('link-identifier') : '');
      if (!itemId) {
        skipped.push({ reason: 'Product link has no Walmart item id', name });
        continue;
      }

      const img = card.querySelector('img[data-testid="productTileImage"]') || card.querySelector('img[src*="walmartimages.com"]');
      const imageUrls = imageUrlsFromImg(img, pageUrl);

      cards.push({
        productId: itemId,
        name,
        // Off-site links keep their URL so the normalizer can reject them explicitly.
        url: this.platform.pageHosts.includes(resolved.url.hostname) ? canonicalWalmartUrl(resolved.url, itemId) : resolved.url.href,
        priceText: readPrice(card),
        imageCandidates: uniqueStrings([upgradeWalmartImageUrl(imageUrls[0]), ...imageUrls]),
        thumbnailUrl: thumbnailFromImg(img, pageUrl),
        sponsored: resolved.sponsored || hasSponsoredLabel(card),
      });
    }

    const nextData = readWalmartNextData(doc);
    enrichFromStructuredData(cards, nextData);
    enrichFromStructuredData(cards, jsonLdById(doc, walmartItemIdFromUrl, pageUrl, (u) => upgradeWalmartImageUrl(u) || u));
    if (nextData.size && cards.length && !cards.some((c) => nextData.has(c.productId))) {
      warnings.push('Walmart page data did not match the visible results (the page may have changed without reloading). Only visible card data was used.');
    }

    return { cards, skipped, warnings };
  }
}

export const walmartAdapter = new WalmartAdapter();
