/**
 * eBay.com search results adapter.
 *
 * Both eBay result layouts are recognised:
 *   - classic: ul.srp-results > li.s-item   (.s-item__title, .s-item__price, .s-item__image img)
 *   - newer:   ul.srp-results > li.s-card   (.s-card__title, .s-card__price, img.s-card__image)
 *   - id:      data-listingid, or the 9-15 digit item id in the /itm/ link
 *   - image:   i.ebayimg.com; "s-l225.jpg"-style size suffixes are raised to s-l1600
 *              (eBay's largest standard size), keeping the original format
 *   - url:     canonical https://www.ebay.com/itm/<item id>
 *
 * eBay always inserts a hidden "Shop on eBay" placeholder card (item 123456);
 * it is skipped. eBay obfuscates its "Sponsored" labels, so sponsored
 * detection is best-effort only on this platform.
 */
import {
  BaseAdapter, textOf, cleanText, firstMatch, imageUrlsFromImg, thumbnailFromImg, hasSponsoredLabel,
  outermost, uniqueStrings, enrichFromStructuredData, jsonLdById,
} from './base-adapter.js';
import { PLATFORMS } from './platforms.js';
import { parseUrl } from '../utils/url.js';

const RESULT_CARD_SELECTOR = '.srp-results li.s-item, .srp-results li.s-card, .srp-results li[data-listingid]';
const ANY_CARD_SELECTOR = 'li.s-item, li.s-card, li[data-listingid]';
const ITEM_ID_PATTERN = /\/itm\/(?:[^/?#]+\/)?(\d{9,15})(?:[/?#]|$)/;
const PLACEHOLDER_ITEM_IDS = new Set(['123456']);

export function ebayItemIdFromHref(href) {
  return String(href ?? '').match(ITEM_ID_PATTERN)?.[1] || '';
}

/** Raises eBay's size suffix to s-l1600; '' when the URL has no size suffix. */
export function upgradeEbayImageUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== 'i.ebayimg.com') return '';
  const match = parsed.pathname.match(/^(?:\/thumbs)?(\/images\/g\/[^/]+\/)s-l\d+\.(jpe?g|png|webp)$/i);
  return match ? `${parsed.origin}${match[1]}s-l1600.${match[2].toLowerCase()}` : '';
}

function readTitle(card) {
  const title = card.querySelector('.s-item__title, .s-card__title');
  if (!title) return '';
  const clone = title.cloneNode(true);
  // Remove "New Listing" badges and hidden "Opens in a new window or tab" text.
  for (const extra of clone.querySelectorAll('.LIGHT_HIGHLIGHT, .clipped, .s-item__title--tag, .s-card__new-listing')) extra.remove();
  return cleanText(clone.textContent)
    .replace(/^New Listing\s*/i, '')
    .replace(/\s*Opens in a new window or tab\s*$/i, '');
}

function readPrice(card) {
  for (const el of card.querySelectorAll('.s-item__price, .s-card__price')) {
    // Skip struck-through "was" prices (classic: .STRIKETHROUGH, newer: .strikethrough).
    if (el.closest('.STRIKETHROUGH, .strikethrough, s, del, strike') || el.querySelector(':scope > .STRIKETHROUGH')) continue;
    const text = textOf(el);
    if (text) return text;
  }
  return '';
}

export class EbayAdapter extends BaseAdapter {
  constructor() {
    super(PLATFORMS.ebay);
  }

  getPageType(url) {
    const path = parseUrl(url)?.pathname || '';
    if (path.startsWith('/sch/')) return 'search';
    if (path.startsWith('/b/')) return 'listing';
    return 'other';
  }

  detectBlockPage(doc) {
    if (/pardon our interruption/i.test(doc.title) || /checking your browser before you access ebay/i.test(doc.body?.textContent || '')) {
      return 'eBay is showing a "Pardon our interruption" / browser check page. Complete it yourself in this tab if you can, then search again. The extension never bypasses these checks.';
    }
    return super.detectBlockPage(doc);
  }

  extract(doc, { pageUrl }) {
    const cards = [];
    const skipped = [];
    const warnings = [];

    let elements = [...doc.querySelectorAll(RESULT_CARD_SELECTOR)];
    if (!elements.length) elements = [...doc.querySelectorAll(ANY_CARD_SELECTOR)];

    for (const card of outermost(elements)) {
      const link = firstMatch(card, ['a.s-item__link[href]', 'a.su-link[href]', 'a[href*="/itm/"]']);
      const listingId = cleanText(card.getAttribute('data-listingid'));
      const itemId = /^\d{9,15}$/.test(listingId) ? listingId : ebayItemIdFromHref(link?.getAttribute('href'));
      const name = readTitle(card);
      const linkItemId = link?.getAttribute('href')?.match(/\/itm\/(\d+)/)?.[1];

      if (PLACEHOLDER_ITEM_IDS.has(listingId) || PLACEHOLDER_ITEM_IDS.has(linkItemId) || /^shop on ebay$/i.test(name)) {
        skipped.push({ reason: 'eBay placeholder card ("Shop on eBay")' });
        continue;
      }
      if (!itemId) {
        skipped.push({ reason: 'Card has no eBay item id', name });
        continue;
      }

      const img = firstMatch(card, [
        '.s-item__image-wrapper img',
        '.s-item__image img',
        'img.s-card__image',
        '.s-card__media-wrapper img',
        'img[src*="ebayimg.com"]',
        'img[data-src*="ebayimg.com"]',
      ]);
      const imageUrls = imageUrlsFromImg(img, pageUrl);

      cards.push({
        productId: itemId,
        name,
        url: `${this.platform.origin}/itm/${itemId}`,
        priceText: readPrice(card),
        imageCandidates: uniqueStrings([upgradeEbayImageUrl(imageUrls[0]), ...imageUrls]),
        thumbnailUrl: thumbnailFromImg(img, pageUrl),
        sponsored: hasSponsoredLabel(card),
      });
    }

    enrichFromStructuredData(cards, jsonLdById(doc, ebayItemIdFromHref, pageUrl, (u) => upgradeEbayImageUrl(u) || u));
    if (cards.length) warnings.push('eBay hides its "Sponsored" labels from page code, so promoted listings may not be filtered out.');
    return { cards, skipped, warnings };
  }
}

export const ebayAdapter = new EbayAdapter();
