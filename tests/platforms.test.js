import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PLATFORMS, detectPlatformFromUrl, imageHostPatterns, isAllowedImageUrl, isPlatformPageUrl,
} from '../src/adapters/platforms.js';
import { ADAPTERS, getAdapterForUrl } from '../src/adapters/adapter-registry.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('supported search pages are detected', () => {
  const cases = {
    'https://www.walmart.com/search?q=tv': 'walmart',
    'https://www.amazon.com/s?k=headphones': 'amazon',
    'https://amazon.com/s?k=headphones': 'amazon',
    'https://www.target.com/s?searchTerm=lamp': 'target',
    'https://www.bestbuy.com/site/searchpage.jsp?st=laptop': 'bestbuy',
    'https://www.ebay.com/sch/i.html?_nkw=camera': 'ebay',
  };
  for (const [url, id] of Object.entries(cases)) assert.equal(detectPlatformFromUrl(url)?.id, id, url);
});

test('unsupported sites, look-alike hosts and non-HTTPS pages are rejected', () => {
  for (const url of [
    'https://www.example.com/',
    'https://www.amazon.co.uk/s?k=x',
    'https://www.amazon.de/s?k=x',
    'https://www.ebay.co.uk/sch/i.html?_nkw=x',
    'https://www.walmart.ca/search?q=x',
    'https://walmart.com.evil.example/search?q=x',
    'https://evilamazon.com/s?k=x',
    'http://www.amazon.com/s?k=x',
    'chrome://extensions',
    'file:///C:/page.html',
    '',
    undefined,
  ]) {
    assert.equal(detectPlatformFromUrl(url), null, String(url));
    assert.equal(getAdapterForUrl(url), null, String(url));
  }
});

test('every platform has exactly one adapter', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id).sort(), Object.keys(PLATFORMS).sort());
});

test('image URLs must be HTTPS on an allowed host for that platform', () => {
  assert.equal(isAllowedImageUrl('https://i.ebayimg.com/images/g/x/s-l1600.jpg', 'ebay'), true);
  assert.equal(isAllowedImageUrl('https://i.ebayimg.com/images/g/x/s-l1600.jpg', 'amazon'), false);
  assert.equal(isAllowedImageUrl('http://i.ebayimg.com/x.jpg', 'ebay'), false);
  assert.equal(isAllowedImageUrl('https://i.ebayimg.com:8443/x.jpg', 'ebay'), false);
  assert.equal(isAllowedImageUrl('https://user:pw@i.ebayimg.com/x.jpg', 'ebay'), false);
  assert.equal(isAllowedImageUrl('https://x.i.ebayimg.com/x.jpg', 'ebay'), false);
  assert.equal(isAllowedImageUrl('https://i.ebayimg.com/x.jpg', 'unknown'), false);
});

test('product page URLs must be on the platform domain', () => {
  assert.equal(isPlatformPageUrl('https://www.target.com/p/x/-/A-1', 'target'), true);
  assert.equal(isPlatformPageUrl('https://www.target.com.evil.example/p', 'target'), false);
});

test('manifest optional host permissions match the platform image hosts exactly', () => {
  assert.deepEqual([...manifest.optional_host_permissions].sort(), imageHostPatterns().sort());
});

test('manifest requests only the documented permissions and no install-time host access', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'downloads', 'offscreen', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});
