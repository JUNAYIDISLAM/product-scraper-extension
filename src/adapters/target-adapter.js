/**
 * Target.com search results adapter.
 *
 * Target renders product cards with React and `data-test` attributes:
 *   - card:   [data-test="@web/site-top-of-funnel/ProductCardWrapper"] (and older variants)
 *   - id:     TCIN from the product link (/p/<slug>/-/A-<TCIN>)
 *   - name:   a[data-test="product-title"]
 *   - price:  [data-test="current-price"] ("$19.99" or "$12.99 - $24.99")
 *   - image:  first <img> of the card's ProductCardImage block (target.scene7.com);
 *             wid/hei are raised to 1200 to request a large rendition.
 *   - ads:    [data-test="sponsoredText"] or a "Sponsored" label.
 *
 * Target only renders cards near the viewport; cards further down the page are
 * empty placeholders until scrolled into view. Those are reported as skipped
 * with a hint to use the popup's "Load more" button. If none of the known card
 * containers exist, cards are located by grouping product links (fallback).
 */
import {
  BaseAdapter, textOf, cleanText, firstText, firstMatch, imageUrlsFromImg, thumbnailFromImg, hasSponsoredLabel,
  outermost, uniqueStrings, groupLinksIntoCards, enrichFromStructuredData, jsonLdById,
} from './base-adapter.js';
import { PLATFORMS } from './platforms.js';
import { parseUrl } from '../utils/url.js';

const CARD_SELECTORS = [
  '[data-test="@web/site-top-of-funnel/ProductCardWrapper"]',
  '[data-test="@web/site-top-of-funnel/ProductCard"]',
  'li[data-test="list-entry-product-card"]',
  '[data-test="product-card"]',
];
const PRODUCT_LINK_SELECTOR = 'a[href*="/-/A-"]';
const TCIN_PATTERN = /\/-\/A-(\d{5,12})(?:[/?#]|$)/;
export const TARGET_IMAGE_SIZE = 1200;

export function targetTcinFromHref(href) {
  return String(href ?? '').match(TCIN_PATTERN)?.[1] || '';
}

/** https://www.target.com/p/<slug>/-/A-<TCIN> without query or fragment. */
export function canonicalTargetUrl(href, baseUrl) {
  const url = parseUrl(href, baseUrl);
  if (!url) return '';
  if (!PLATFORMS.target.pageHosts.includes(url.hostname)) return url.href;
  return `${PLATFORMS.target.origin}${url.pathname}`;
}

/** Requests a larger scene7 rendition; '' when the URL is not a scene7 image. */
export function upgradeTargetImageUrl(url, size = TARGET_IMAGE_SIZE) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== 'target.scene7.com' || !parsed.pathname.startsWith('/is/image/')) return '';
  parsed.searchParams.set('wid', String(size));
  parsed.searchParams.set('hei', String(size));
  return parsed.href;
}

export class TargetAdapter extends BaseAdapter {
  constructor() {
    super(PLATFORMS.target);
  }

  getPageType(url) {
    const path = parseUrl(url)?.pathname || '';
    if (path === '/s' || path.startsWith('/s/')) return 'search';
    if (path.startsWith('/c/')) return 'listing';
    return 'other';
  }

  extract(doc, { pageUrl }) {
    const cards = [];
    const skipped = [];
    const warnings = [];

    let containers = outermost(CARD_SELECTORS.flatMap((selector) => [...doc.querySelectorAll(selector)]));
    if (!containers.length) {
      containers = groupLinksIntoCards(doc, PRODUCT_LINK_SELECTOR, targetTcinFromHref);
      if (containers.length) {
        warnings.push('Target product cards were located by their product links (fallback mode) because the usual card containers were not found. Check the preview carefully.');
      }
    }

    let placeholders = 0;
    for (const card of containers) {
      const link = firstMatch(card, ['a[data-test="product-title"][href]', PRODUCT_LINK_SELECTOR]);
      const tcin = targetTcinFromHref(link?.getAttribute('href'));
      if (!link || !tcin) {
        placeholders += 1;
        continue;
      }
      const img = firstMatch(card, [
        '[data-test*="ProductCardImage"] img',
        'picture img',
        'img[src*="scene7.com"]',
      ]);
      const imageUrls = imageUrlsFromImg(img, pageUrl);
      // The first product link is often the image link (no text), so look at every product link.
      const name =
        firstText(card, ['a[data-test="product-title"]', '[data-test="@web/ProductCard/title"]', PRODUCT_LINK_SELECTOR]) ||
        cleanText(link.getAttribute('aria-label')) ||
        cleanText(img?.getAttribute('alt'));

      cards.push({
        productId: tcin,
        name,
        url: canonicalTargetUrl(link.getAttribute('href'), pageUrl),
        priceText: firstText(card, ['[data-test="current-price"]', '[data-test="product-price"]']),
        imageCandidates: uniqueStrings([upgradeTargetImageUrl(imageUrls[0]), ...imageUrls]),
        thumbnailUrl: thumbnailFromImg(img, pageUrl),
        sponsored: Boolean(card.querySelector('[data-test="sponsoredText"]')) || hasSponsoredLabel(card),
      });
    }
    if (placeholders) {
      skipped.push(
        ...Array.from({ length: placeholders }, () => ({
          reason: 'Card not loaded yet (click "Load more" to scroll the page and rescan)',
        })),
      );
    }

    enrichFromStructuredData(cards, jsonLdById(doc, targetTcinFromHref, pageUrl, (u) => upgradeTargetImageUrl(u) || u));
    return { cards, skipped, warnings };
  }
}

export const targetAdapter = new TargetAdapter();
