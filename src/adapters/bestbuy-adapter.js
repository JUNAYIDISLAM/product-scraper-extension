/**
 * BestBuy.com search results adapter.
 *
 * Best Buy has used more than one search layout, so several card containers
 * are recognised, with a link-grouping fallback:
 *   - card:   li.sku-item[data-sku-id] (classic) or li.product-list-item (newer)
 *   - id:     the SKU (data-sku-id, or skuId=/<sku>.p/sku/<sku> in the product link)
 *   - name:   .sku-title / h4.sku-header / .product-title link text
 *   - price:  .priceView-customer-price first visible amount, or
 *             [data-testid="customer-price"]; struck-through "Was" prices and
 *             "Save $X" amounts are ignored
 *   - image:  pisces.bbystatic.com image; the ";maxHeight=..;maxWidth=.." resize
 *             parameters are removed to get the original image
 */
import {
  BaseAdapter, textOf, cleanText, firstText, firstMatch, imageUrlsFromImg, thumbnailFromImg, hasSponsoredLabel,
  outermost, uniqueStrings, groupLinksIntoCards, enrichFromStructuredData, jsonLdById,
} from './base-adapter.js';
import { PLATFORMS } from './platforms.js';
import { parseUrl } from '../utils/url.js';

const CARD_SELECTORS = ['li.sku-item', 'li.product-list-item', '[data-testid="product-card"]'];
const LINK_SELECTORS = [
  '.sku-title a[href]',
  'h4.sku-header a[href]',
  '.product-title a[href]',
  'h2 a[href]',
  'a.product-list-item-link[href]',
  'a[href*="skuId="]',
  'a[href*=".p?"]',
];
const FALLBACK_LINK_SELECTOR = 'a[href*="skuId="], a[href*=".p?"], a[href*="/sku/"]';

export function bestBuySkuFromHref(href) {
  const text = String(href ?? '');
  return (
    text.match(/[?&]skuId=(\d{5,9})(?:&|#|$)/)?.[1] ||
    text.match(/\/(\d{5,9})\.p(?:[?#/]|$)/)?.[1] ||
    text.match(/\/sku\/(\d{5,9})(?:[/?#]|$)/)?.[1] ||
    ''
  );
}

/** Canonical product URL: path plus ?skuId= for classic ".p" URLs, path only otherwise. */
export function canonicalBestBuyUrl(href, baseUrl, sku) {
  const url = parseUrl(href, baseUrl);
  if (!url) return '';
  if (!PLATFORMS.bestbuy.pageHosts.includes(url.hostname)) return url.href;
  const base = `${PLATFORMS.bestbuy.origin}${url.pathname}`;
  return url.pathname.endsWith('.p') && sku ? `${base}?skuId=${sku}` : base;
}

/** Strips ";maxHeight=..;maxWidth=..;format=.." from pisces.bbystatic.com URLs; '' when not applicable. */
export function upgradeBestBuyImageUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== 'pisces.bbystatic.com' || !parsed.pathname.includes(';')) return '';
  return `${parsed.origin}${parsed.pathname.split(';')[0]}`;
}

function readSku(card, link) {
  const attr = card.getAttribute('data-sku-id') || card.querySelector('[data-sku-id]')?.getAttribute('data-sku-id') || '';
  if (/^\d{5,9}$/.test(attr.trim())) return attr.trim();
  return bestBuySkuFromHref(link?.getAttribute('href'));
}

function readPrice(card) {
  const block = firstMatch(card, [
    '.priceView-customer-price',
    '[data-testid="customer-price"]',
    '[data-testid="large-customer-price"]',
    '.customer-price',
  ]);
  if (block) {
    const visible = block.querySelector('span[aria-hidden="true"]') || block.querySelector('span');
    const text = textOf(visible) || textOf(block);
    if (/\d/.test(text)) return text;
  }
  // Screen-reader text used by Best Buy: "Your price for this item is $199.99".
  const match = cleanText(card.textContent).match(/your price for this item is\s*(\$\s?[\d,]+(?:\.\d{2})?)/i);
  return match ? match[1] : '';
}

export class BestBuyAdapter extends BaseAdapter {
  constructor() {
    super(PLATFORMS.bestbuy);
  }

  getPageType(url) {
    const path = parseUrl(url)?.pathname || '';
    if (path === '/site/searchpage.jsp') return 'search';
    if (/^\/site\/.+\/pcmcat\d+\.c$/.test(path) || /\/abcat\d+\.c$/.test(path)) return 'listing';
    return 'other';
  }

  detectBlockPage(doc) {
    if (doc.querySelector('.country-selection') && !doc.querySelector(CARD_SELECTORS.join(','))) {
      return 'Best Buy is showing its country selection page. Choose "United States", search again, then reopen the extension.';
    }
    return super.detectBlockPage(doc);
  }

  extract(doc, { pageUrl }) {
    const cards = [];
    const skipped = [];
    const warnings = [];

    let containers = outermost(CARD_SELECTORS.flatMap((selector) => [...doc.querySelectorAll(selector)]));
    if (!containers.length) {
      containers = groupLinksIntoCards(doc, FALLBACK_LINK_SELECTOR, bestBuySkuFromHref);
      if (containers.length) {
        warnings.push('Best Buy product cards were located by their product links (fallback mode) because the usual card containers were not found. Check the preview carefully.');
      }
    }

    for (const card of containers) {
      const link = firstMatch(card, LINK_SELECTORS);
      const sku = readSku(card, link);
      const name =
        firstText(card, ['.sku-title a', 'h4.sku-header a', '.sku-title', 'h4.sku-header', '.product-title', '[data-testid="product-title"]']) ||
        textOf(link);
      if (!link) {
        skipped.push({ reason: 'Card has no product link', name, productId: sku });
        continue;
      }
      if (!sku) {
        skipped.push({ reason: 'Card has no Best Buy SKU', name });
        continue;
      }
      const img = firstMatch(card, ['img.product-image', '.image-column img', 'img[src*="bbystatic.com"]', 'img[data-src*="bbystatic.com"]']);
      const imageUrls = imageUrlsFromImg(img, pageUrl);

      cards.push({
        productId: sku,
        name: name || cleanText(img?.getAttribute('alt')),
        url: canonicalBestBuyUrl(link.getAttribute('href'), pageUrl, sku),
        priceText: readPrice(card),
        imageCandidates: uniqueStrings([upgradeBestBuyImageUrl(imageUrls[0]), ...imageUrls]),
        thumbnailUrl: thumbnailFromImg(img, pageUrl),
        sponsored: Boolean(card.querySelector('.sponsored-ad, [data-testid="sponsored-label"]')) || hasSponsoredLabel(card),
      });
    }

    enrichFromStructuredData(cards, jsonLdById(doc, bestBuySkuFromHref, pageUrl, (u) => upgradeBestBuyImageUrl(u) || u));
    return { cards, skipped, warnings };
  }
}

export const bestBuyAdapter = new BestBuyAdapter();
