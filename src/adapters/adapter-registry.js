/**
 * The list of available adapters. To add a platform:
 *   1. add its metadata to platforms.js (and its image hosts to manifest.json),
 *   2. create <name>-adapter.js extending BaseAdapter,
 *   3. add the adapter instance to ADAPTERS below.
 * See docs/ADDING_A_PLATFORM.md for the full walkthrough.
 */
import { detectPlatformFromUrl } from './platforms.js';
import { walmartAdapter } from './walmart-adapter.js';
import { amazonAdapter } from './amazon-adapter.js';
import { targetAdapter } from './target-adapter.js';
import { bestBuyAdapter } from './bestbuy-adapter.js';
import { ebayAdapter } from './ebay-adapter.js';

export const ADAPTERS = Object.freeze([walmartAdapter, amazonAdapter, targetAdapter, bestBuyAdapter, ebayAdapter]);

export function getAdapterById(id) {
  return ADAPTERS.find((adapter) => adapter.id === id) || null;
}

/** Returns the adapter for the page URL, or null when the site is not supported. */
export function getAdapterForUrl(url) {
  const platform = detectPlatformFromUrl(url);
  return platform ? getAdapterById(platform.id) : null;
}
