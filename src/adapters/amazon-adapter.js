/**
 * Amazon.com search results adapter.
 *
 * Product cards: div[data-component-type="s-search-result"][data-asin]
 *   - id:     data-asin (10-character ASIN)
 *   - name:   the <h2> inside the title link (plus the separate brand line some
 *             categories show above the title)
 *   - price:  .a-price .a-offscreen, excluding struck-through list prices
 *             (.a-text-price) and "More buying choices" offers
 *   - image:  img.s-image; the size modifier is removed from the file name
 *             ("71abc._AC_UY218_.jpg" -> "71abc.jpg") to get the full-size image
 *   - url:    canonical https://www.amazon.com/dp/<ASIN>
 * Amazon search pages carry no product JSON-LD, so only the DOM is used.
 */
import {
  BaseAdapter, textOf, cleanText, imageUrlsFromImg, thumbnailFromImg, hasSponsoredLabel,
  outermost, uniqueStrings, parseSrcset, absoluteUrl,
} from './base-adapter.js';
import { PLATFORMS } from './platforms.js';
import { parseUrl } from '../utils/url.js';

const CARD_SELECTOR = 'div[data-component-type="s-search-result"]';
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

/** Removes Amazon's resize modifiers; returns '' when the URL has none. */
export function upgradeAmazonImageUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  const match = parsed.pathname.match(/^(\/images\/[IG]\/[^/.]+)\.[^/]*\.(jpe?g|png|webp|gif)$/i);
  return match ? `${parsed.origin}${match[1]}.${match[2]}` : '';
}

function readTitle(card) {
  const scope = card.querySelector('[data-cy="title-recipe"]') || card;
  const headings = [...scope.querySelectorAll('h2')];
  const title =
    headings.find((h) => h.closest('a[href]') || h.querySelector('a[href]')) ||
    headings.find((h) => h.getAttribute('aria-label')) ||
    headings.at(-1);
  if (!title) return '';
  let name = textOf(title) || cleanText(title.getAttribute('aria-label'));
  name = name.replace(/^Sponsored Ad\s*[-–—]\s*/i, '');

  // Some categories (e.g. fashion) show the brand in a separate small heading.
  const brandHeading = headings.find((h) => h !== title && h.classList.contains('a-size-mini') && !h.closest('a[href]'));
  const brand = textOf(brandHeading);
  if (brand && name && !name.toLowerCase().startsWith(brand.toLowerCase())) name = `${brand} ${name}`;
  return name;
}

function textBetween(first, second) {
  let text = '';
  for (let node = first.nextSibling; node && node !== second; node = node.nextSibling) text += node.textContent;
  return text;
}

function readPrice(card) {
  const scope = card.querySelector('[data-cy="price-recipe"]') || card;
  const prices = [...scope.querySelectorAll('.a-price')].filter(
    (el) => !el.classList.contains('a-text-price') && !el.closest('.a-text-price, [data-cy="secondary-offer-recipe"]'),
  );
  const first = prices[0];
  if (!first) return '';
  const firstText = textOf(first.querySelector('.a-offscreen')) || textOf(first);
  const second = prices[1];
  // Price ranges are rendered as two .a-price siblings separated by " - ".
  if (second && second.parentElement === first.parentElement && /^\s*[-–]\s*$/.test(textBetween(first, second))) {
    return `${firstText} - ${textOf(second.querySelector('.a-offscreen')) || textOf(second)}`;
  }
  return firstText;
}

function isSponsored(card) {
  return Boolean(
    card.classList.contains('AdHolder') ||
      card.querySelector(
        '.puis-sponsored-label-text, .s-sponsored-label-text, a[href*="/sspa/click"], h2[aria-label^="Sponsored"], [data-component-type="sp-sponsored-result"]',
      ) ||
      hasSponsoredLabel(card),
  );
}

export class AmazonAdapter extends BaseAdapter {
  constructor() {
    super(PLATFORMS.amazon);
  }

  getPageType(url) {
    const path = parseUrl(url)?.pathname || '';
    if (path === '/s' || path.startsWith('/s/')) return 'search';
    if (path === '/b' || path.startsWith('/b/') || /\/b\/?$/.test(path)) return 'listing';
    return 'other';
  }

  detectBlockPage(doc) {
    if (doc.querySelector('form[action*="/errors/validateCaptcha"]') || /enter the characters you see below/i.test(doc.body?.textContent || '')) {
      return 'Amazon is showing a "Robot Check" CAPTCHA page. Solve it yourself in this tab if you can, then search again. The extension never bypasses CAPTCHAs.';
    }
    return super.detectBlockPage(doc);
  }

  extract(doc, { pageUrl }) {
    const cards = [];
    const skipped = [];
    const warnings = [];

    for (const card of outermost([...doc.querySelectorAll(CARD_SELECTOR)])) {
      const asin = cleanText(card.getAttribute('data-asin')).toUpperCase();
      if (!ASIN_PATTERN.test(asin)) {
        skipped.push({ reason: 'Result card without a valid ASIN', name: readTitle(card) });
        continue;
      }

      const img = card.querySelector('img.s-image') || card.querySelector('img[src*="media-amazon.com"]');
      const imageUrls = imageUrlsFromImg(img, pageUrl);
      const largest = parseSrcset(img?.getAttribute('srcset')).map((c) => absoluteUrl(c.url, pageUrl))[0] || imageUrls[0];

      cards.push({
        productId: asin,
        name: readTitle(card),
        url: `${this.platform.origin}/dp/${asin}`,
        priceText: readPrice(card),
        imageCandidates: uniqueStrings([upgradeAmazonImageUrl(largest), ...imageUrls]),
        thumbnailUrl: thumbnailFromImg(img, pageUrl),
        sponsored: isSponsored(card),
      });
    }

    return { cards, skipped, warnings };
  }
}

export const amazonAdapter = new AmazonAdapter();
