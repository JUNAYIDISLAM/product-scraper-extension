/**
 * Page scanning logic used by the content script.
 *
 * Kept free of chrome.* APIs so it can be unit-tested with jsdom fixtures.
 */
import { getAdapterForUrl } from '../adapters/adapter-registry.js';
import { supportedPlatformNames } from '../adapters/platforms.js';
import { normalizeScanResult } from '../services/product-normalizer.js';
import { ErrorCodes } from '../utils/errors.js';

const PRODUCT_FIELDS_FOR_POPUP = [
  'platform', 'product_id', 'product_name', 'price', 'currency', 'product_url',
  'image_url', 'image', 'image_candidates', 'thumbnail_url', 'sponsored', 'warnings',
];

/**
 * Scans `doc` (whose URL is `pageUrl`) with the matching adapter.
 *
 * @returns {object} `{ ok: true, platform, pageUrl, pageType, products, detectedCount, skipped, warnings, ... }`
 *                   or `{ ok: false, error: { code, message }, platform? }`
 */
export function scanDocument(doc, pageUrl, { limit, includeSponsored } = {}) {
  const adapter = getAdapterForUrl(pageUrl);
  if (!adapter) {
    return {
      ok: false,
      error: {
        code: ErrorCodes.UNSUPPORTED_SITE,
        message: `This website is not supported. Supported: ${supportedPlatformNames().join(', ')}.`,
      },
    };
  }
  const platform = { id: adapter.id, name: adapter.name };

  const blockMessage = adapter.detectBlockPage(doc);
  if (blockMessage) return { ok: false, platform, error: { code: ErrorCodes.BLOCKED_PAGE, message: blockMessage } };

  let extraction;
  try {
    extraction = adapter.extract(doc, { pageUrl });
  } catch (error) {
    return {
      ok: false,
      platform,
      error: { code: ErrorCodes.SCAN_FAILED, message: `The ${adapter.name} adapter could not read this page: ${error?.message || error}` },
    };
  }

  const result = normalizeScanResult(extraction, adapter.platform, { limit, includeSponsored });
  const pageType = adapter.getPageType(pageUrl);
  const warnings = [...result.warnings];
  if (pageType === 'other') {
    warnings.unshift(`This does not look like a search results page on ${adapter.name}. Search for products first, then open the extension on the results page.`);
  } else if (pageType === 'listing') {
    warnings.unshift(`This is a ${adapter.name} category page, not a search page. It usually works, but only search results pages are covered by tests.`);
  }
  if (result.cardsFound === 0 && pageType !== 'other') {
    warnings.push(`No product cards were found. If products are visible, ${adapter.name} may have changed its page layout and the adapter needs updating.`);
  }

  return {
    ok: true,
    platform,
    pageUrl,
    pageType,
    scannedAt: new Date().toISOString(),
    cardsFound: result.cardsFound,
    detectedCount: result.detectedCount,
    sponsoredCount: result.sponsoredCount,
    limit: result.limit,
    includeSponsored: Boolean(includeSponsored),
    products: result.products.map((product) => Object.fromEntries(PRODUCT_FIELDS_FOR_POPUP.map((key) => [key, product[key]]))),
    skipped: result.skipped.slice(0, 200),
    skippedSummary: result.skippedSummary,
    warnings,
  };
}

/**
 * Scrolls the page down in viewport-sized steps so lazy-loaded cards render,
 * then returns to the original position. Bounded by `maxSteps`, and it stops
 * at the bottom of the page. It never clicks "next page" or "load more".
 */
export async function autoScroll(win, { maxSteps = 12, delayMs = 450 } = {}) {
  const sleep = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
  const startY = win.scrollY;
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    const before = win.scrollY;
    win.scrollBy(0, Math.round(win.innerHeight * 0.85));
    await sleep(delayMs);
    if (Math.abs(win.scrollY - before) < 2) break;
  }
  win.scrollTo(0, startY);
  await sleep(200);
  return { steps };
}
