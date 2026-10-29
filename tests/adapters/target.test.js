import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetAdapter, targetTcinFromHref, upgradeTargetImageUrl } from '../../src/adapters/target-adapter.js';
import { scanDocument } from '../../src/content/scan.js';
import { loadFixture } from '../helpers.js';

const URL_SEARCH = 'https://www.target.com/s?searchTerm=lamp';
const scan = (options = {}) => scanDocument(loadFixture('target-search.html', URL_SEARCH), URL_SEARCH, { limit: 100, ...options });

test('detects rendered cards and reports unrendered placeholders', () => {
  const result = scan();
  assert.equal(result.ok, true);
  assert.deepEqual(result.products.map((p) => p.product_id), ['80000001', '80000003']);
  assert.equal(result.skippedSummary['Card not loaded yet (click "Load more" to scroll the page and rescan)'], 2);
  assert.equal(result.sponsoredCount, 1);
});

test('extracts the fields of a card', () => {
  const [lamp] = scan().products;
  assert.equal(lamp.product_name, 'Ceramic Table Lamp - Threshold');
  assert.equal(lamp.price, '34.99');
  assert.equal(lamp.product_url, 'https://www.target.com/p/ceramic-table-lamp-threshold/-/A-80000001');
  assert.equal(lamp.image_url, 'https://target.scene7.com/is/image/Target/GUEST_lamp0001?wid=1200&hei=1200&qlt=80&fmt=webp');
  assert.equal(lamp.thumbnail_url, 'https://target.scene7.com/is/image/Target/GUEST_lamp0001?wid=300&hei=300&qlt=80&fmt=pjpeg');
});

test('"See price in cart" leaves the price empty instead of guessing', () => {
  const floor = scan().products.find((p) => p.product_id === '80000003');
  assert.equal(floor.price, '');
  assert.equal(floor.product_name, 'Arc Floor Lamp Brass - Project 62™');
});

test('sponsored cards with price ranges', () => {
  const ad = scan({ includeSponsored: true }).products.find((p) => p.sponsored);
  assert.equal(ad.product_id, '80000002');
  assert.equal(ad.price, '19.99 - 29.99');
  assert.equal(ad.product_url, 'https://www.target.com/p/led-desk-lamp/-/A-80000002');
});

test('falls back to grouping product links when card containers are missing', () => {
  const url = 'https://www.target.com/s?searchTerm=mug';
  const result = scanDocument(loadFixture('target-fallback.html', url), url, { limit: 100 });
  assert.deepEqual(result.products.map((p) => [p.product_id, p.product_name]), [
    ['90000001', 'Stoneware Mug 16oz'],
    ['90000002', 'Double Wall Glass Mug'],
  ]);
  assert.ok(result.products[0].image_url.includes('GUEST_mug0001'));
  assert.ok(result.products[1].image_url.includes('GUEST_mug0002'));
  assert.ok(result.warnings.some((w) => /fallback mode/.test(w)));
});

test('helpers', () => {
  assert.equal(targetTcinFromHref('/p/x/-/A-12345678#lnk=sametab'), '12345678');
  assert.equal(targetTcinFromHref('/c/lamps/-/N-4yi5p'), '');
  assert.equal(upgradeTargetImageUrl('https://target.scene7.com/is/image/Target/GUEST_1?wid=300&hei=300'), 'https://target.scene7.com/is/image/Target/GUEST_1?wid=1200&hei=1200');
  assert.equal(upgradeTargetImageUrl('https://example.com/a.jpg'), '');
  assert.equal(targetAdapter.getPageType('https://www.target.com/s?searchTerm=lamp'), 'search');
  assert.equal(targetAdapter.getPageType('https://www.target.com/c/lamps/-/N-4yi5p'), 'listing');
});
