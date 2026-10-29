/**
 * Static metadata for every supported platform.
 *
 * This file contains no DOM code, so it can be shared by the content script,
 * the popup, the background service worker and the offscreen export document.
 *
 * `pageHosts`  - exact hostnames where the extension may read search results.
 * `imageHosts` - exact HTTPS hostnames the extension is allowed to download
 *                images from. Every host listed here must also appear in
 *                `optional_host_permissions` in manifest.json (a unit test
 *                checks this).
 */
import { parseUrl } from '../utils/url.js';

export const PLATFORMS = Object.freeze({
  walmart: Object.freeze({
    id: 'walmart',
    name: 'Walmart',
    pageHosts: Object.freeze(['www.walmart.com', 'walmart.com']),
    imageHosts: Object.freeze(['i5.walmartimages.com']),
    defaultCurrency: 'USD',
    origin: 'https://www.walmart.com',
  }),
  amazon: Object.freeze({
    id: 'amazon',
    name: 'Amazon.com',
    pageHosts: Object.freeze(['www.amazon.com', 'amazon.com']),
    imageHosts: Object.freeze(['m.media-amazon.com', 'images-na.ssl-images-amazon.com']),
    defaultCurrency: 'USD',
    origin: 'https://www.amazon.com',
  }),
  target: Object.freeze({
    id: 'target',
    name: 'Target',
    pageHosts: Object.freeze(['www.target.com', 'target.com']),
    imageHosts: Object.freeze(['target.scene7.com']),
    defaultCurrency: 'USD',
    origin: 'https://www.target.com',
  }),
  bestbuy: Object.freeze({
    id: 'bestbuy',
    name: 'Best Buy',
    pageHosts: Object.freeze(['www.bestbuy.com', 'bestbuy.com']),
    imageHosts: Object.freeze(['pisces.bbystatic.com']),
    defaultCurrency: 'USD',
    origin: 'https://www.bestbuy.com',
  }),
  ebay: Object.freeze({
    id: 'ebay',
    name: 'eBay',
    pageHosts: Object.freeze(['www.ebay.com', 'ebay.com']),
    imageHosts: Object.freeze(['i.ebayimg.com']),
    defaultCurrency: 'USD',
    origin: 'https://www.ebay.com',
  }),
});

export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

/** @returns {typeof PLATFORMS[keyof typeof PLATFORMS] | null} */
export function getPlatform(id) {
  return typeof id === 'string' && Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id] : null;
}

/**
 * Returns the platform whose page host exactly matches the URL, or null.
 * Exact matching means look-alike hosts such as `walmart.com.example.net`
 * are never treated as supported.
 */
export function detectPlatformFromUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  for (const platform of Object.values(PLATFORMS)) {
    if (platform.pageHosts.includes(host)) return platform;
  }
  return null;
}

/** True when `url` is an HTTPS URL on one of the platform's page hosts. */
export function isPlatformPageUrl(url, platformId) {
  const platform = getPlatform(platformId);
  const parsed = parseUrl(url);
  return Boolean(
    platform &&
      parsed &&
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      platform.pageHosts.includes(parsed.hostname.toLowerCase()),
  );
}

/**
 * True when `url` is an HTTPS URL on one of the platform's allowed image
 * hosts, on the default port and without embedded credentials.
 */
export function isAllowedImageUrl(url, platformId) {
  const platform = getPlatform(platformId);
  const parsed = parseUrl(url);
  return Boolean(
    platform &&
      parsed &&
      parsed.protocol === 'https:' &&
      parsed.port === '' &&
      !parsed.username &&
      !parsed.password &&
      platform.imageHosts.includes(parsed.hostname.toLowerCase()),
  );
}

/** Host permission match patterns (e.g. `https://i.ebayimg.com/*`) for the given platforms. */
export function imageHostPatterns(platformIds = PLATFORM_IDS) {
  const patterns = new Set();
  for (const id of platformIds) {
    const platform = getPlatform(id);
    if (!platform) continue;
    for (const host of platform.imageHosts) patterns.add(`https://${host}/*`);
  }
  return [...patterns];
}

export function supportedPlatformNames() {
  return Object.values(PLATFORMS).map((p) => p.name);
}
