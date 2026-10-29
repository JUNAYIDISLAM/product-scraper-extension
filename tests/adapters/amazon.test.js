import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amazonAdapter, upgradeAmazonImageUrl } from '../../src/adapters/amazon-adapter.js';
import { scanDocument } from '../../src/content/scan.js';
import { documentFromHtml, loadFixture } from '../helpers.js';

const URL_SEARCH = 'https://www.amazon.com/s?k=wireless+headphones';
const scan = (options = {}) => scanDocument(loadFixture('amazon-search.html', URL_SEARCH), URL_SEARCH, { limit: 100, ...options });

test('detects organic results and excludes sponsored ones by default', () => {
  const result = scan();
  assert.equal(result.ok, true);
  assert.equal(result.platform.id, 'amazon');
  assert.equal(result.pageType, 'search');
  assert.deepEqual(result.products.map((p) => p.product_id), ['B0TEST0001', 'B0TEST0003', 'B0TEST0004', 'B0TEST0005', 'B0TEST0006']);
  assert.equal(result.detectedCount, 5);
  assert.equal(result.sponsoredCount, 1);
  assert.equal(result.cardsFound, 8);
});

test('extracts name, price, canonical URL and the full-size image of each card', () => {
  const [first] = scan().products;
  assert.equal(first.product_name, 'Soundwave Wireless Headphones, Active Noise Cancelling, 40H Playtime');
  assert.equal(first.price, '59.99');
  assert.equal(first.currency, 'USD');
  assert.equal(first.product_url, 'https://www.amazon.com/dp/B0TEST0001');
  assert.equal(first.image_url, 'https://m.media-amazon.com/images/I/61img0001.jpg');
  assert.deepEqual(first.image_candidates.slice(0, 2), [
    'https://m.media-amazon.com/images/I/61img0001.jpg',
    'https://m.media-amazon.com/images/I/61img0001._AC_UY436_QL65_.jpg',
  ]);
  assert.equal(first.thumbnail_url, 'https://m.media-amazon.com/images/I/61img0001._AC_UY218_.jpg');
});

test('every image belongs to the product of the same card', () => {
  for (const product of scan({ includeSponsored: true }).products) {
    if (!product.image_url) continue;
    assert.ok(product.image_url.includes(`61img${product.product_id.slice(-4)}`), `${product.product_id} -> ${product.image_url}`);
  }
});

test('ignores struck-through list prices, unit prices and "more buying choices" offers', () => {
  const byId = Object.fromEntries(scan().products.map((p) => [p.product_id, p]));
  assert.equal(byId.B0TEST0003.price, '15.99 - 29.99');
  assert.equal(byId.B0TEST0004.price, '');
  assert.equal(byId.B0TEST0005.price, '1299.00');
});

test('combines a separate brand heading with the title', () => {
  const byId = Object.fromEntries(scan().products.map((p) => [p.product_id, p]));
  assert.equal(byId.B0TEST0003.product_name, 'Acme Audio Kids Over-Ear Headphones, Volume Limited');
  assert.equal(byId.B0TEST0005.product_name, 'Studio Monitor Headphones with Coiled Cable');
});

test('a title containing the word "Sponsored" is not treated as an ad', () => {
  const byId = Object.fromEntries(scan().products.map((p) => [p.product_id, p]));
  assert.equal(byId.B0TEST0004.sponsored, false);
});

test('sponsored results are included on request and flagged', () => {
  const ad = scan({ includeSponsored: true }).products.find((p) => p.product_id === 'B0TEST0002');
  assert.equal(ad.sponsored, true);
  assert.equal(ad.product_name, 'BassPro Earbuds, Bluetooth 5.3');
  assert.equal(ad.product_url, 'https://www.amazon.com/dp/B0TEST0002');
});

test('products without an image are kept with an empty image URL', () => {
  const noImage = scan().products.find((p) => p.product_id === 'B0TEST0006');
  assert.equal(noImage.image_url, '');
  assert.equal(noImage.price, '9.49');
});

test('reports skipped cards with reasons', () => {
  const { skippedSummary } = scan();
  assert.equal(skippedSummary['Result card without a valid ASIN'], 1);
  assert.equal(skippedSummary['Duplicate of a product already listed'], 1);
  assert.equal(skippedSummary['Sponsored listing (enable "Include sponsored" to keep it)'], 1);
});

test('editorial widgets are not product cards', () => {
  assert.ok(!scan({ includeSponsored: true }).products.some((p) => p.product_id === 'B0TEST0099'));
});

test('the limit keeps the first N products in page order', () => {
  assert.deepEqual(scan({ limit: 2 }).products.map((p) => p.product_id), ['B0TEST0001', 'B0TEST0003']);
});

test('upgradeAmazonImageUrl strips resize modifiers only', () => {
  assert.equal(upgradeAmazonImageUrl('https://m.media-amazon.com/images/I/71x+abc._AC_UY218_.jpg'), 'https://m.media-amazon.com/images/I/71x+abc.jpg');
  assert.equal(upgradeAmazonImageUrl('https://m.media-amazon.com/images/I/71abc._AC_SX679_QL70_ML2_.png'), 'https://m.media-amazon.com/images/I/71abc.png');
  assert.equal(upgradeAmazonImageUrl('https://m.media-amazon.com/images/I/71abc.jpg'), '');
  assert.equal(upgradeAmazonImageUrl('not a url'), '');
});

test('the CAPTCHA page is reported instead of returning empty data', () => {
  const doc = documentFromHtml(
    '<html><head><title>Amazon.com</title></head><body><h4>Enter the characters you see below</h4><form method="get" action="/errors/validateCaptcha"><input name="field-keywords"></form></body></html>',
    URL_SEARCH,
  );
  const result = scanDocument(doc, URL_SEARCH, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BLOCKED_PAGE');
  assert.match(result.error.message, /never bypasses/);
});

test('a search with no results returns an empty list and a layout hint', () => {
  const doc = documentFromHtml('<html><body><div class="s-main-slot"><span>No results for qwertyuiop.</span></div></body></html>', URL_SEARCH);
  const result = scanDocument(doc, URL_SEARCH, {});
  assert.equal(result.ok, true);
  assert.equal(result.products.length, 0);
  assert.ok(result.warnings.some((w) => /No product cards were found/.test(w)));
});

test('page types are recognised', () => {
  assert.equal(amazonAdapter.getPageType('https://www.amazon.com/s?k=x'), 'search');
  assert.equal(amazonAdapter.getPageType('https://www.amazon.com/Electronics/b?node=172282'), 'listing');
  assert.equal(amazonAdapter.getPageType('https://www.amazon.com/dp/B0TEST0001'), 'other');
});
