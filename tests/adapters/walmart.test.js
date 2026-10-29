import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWalmartLink, upgradeWalmartImageUrl, walmartAdapter } from '../../src/adapters/walmart-adapter.js';
import { scanDocument } from '../../src/content/scan.js';
import { documentFromHtml, loadFixture } from '../helpers.js';

const URL_SEARCH = 'https://www.walmart.com/search?q=tv';
const scan = (options = {}) => scanDocument(loadFixture('walmart-search.html', URL_SEARCH), URL_SEARCH, { limit: 100, ...options });

test('detects product cards (outermost [data-item-id]) in page order', () => {
  const result = scan();
  assert.equal(result.ok, true);
  assert.deepEqual(result.products.map((p) => p.product_id), ['123456789', '555555555', '444444444', '666666666']);
  assert.equal(result.sponsoredCount, 1);
  assert.equal(result.skippedSummary['Card has no product link'], 1);
});

test('reads the screen-reader price, not the split visual price', () => {
  const [tv] = scan().products;
  assert.equal(tv.price, '198.00');
  assert.equal(tv.currency, 'USD');
  assert.equal(tv.product_name, 'onn. 50” Class 4K UHD (2160P) LED Roku Smart TV HDR');
  assert.equal(tv.product_url, 'https://www.walmart.com/ip/onn-50-Class-4K-UHD-LED-Roku-Smart-TV/123456789');
});

test('requests the original image by removing the resize query', () => {
  const [tv] = scan().products;
  assert.equal(tv.image_url, 'https://i5.walmartimages.com/seo/onn-50-Class-4K-UHD_123456789.jpeg');
  assert.ok(tv.image_candidates.includes('https://i5.walmartimages.com/seo/onn-50-Class-4K-UHD_123456789.jpeg?odnHeight=360&odnWidth=360&odnBg=FFFFFF'));
});

test('fills a missing price from __NEXT_DATA__ for the same item only', () => {
  const byId = Object.fromEntries(scan().products.map((p) => [p.product_id, p]));
  assert.equal(byId['555555555'].price, '129.99');
  assert.ok(!('999999999' in byId), 'structured items that are not on the page are never added');
});

test('keeps products without an image and reports it', () => {
  const cable = scan().products.find((p) => p.product_id === '444444444');
  assert.equal(cable.image_url, '');
  assert.equal(cable.price, '7.88');
  assert.ok(cable.warnings.some((w) => /no main image/i.test(w)));
});

test('price ranges and canonical URLs without tracking parameters', () => {
  const mount = scan().products.find((p) => p.product_id === '666666666');
  assert.equal(mount.price, '12.99 - 24.99');
  assert.equal(mount.product_url, 'https://www.walmart.com/ip/Universal-TV-Wall-Mount/666666666');
});

test('sponsored /sp/track links resolve to the real product', () => {
  const ad = scan({ includeSponsored: true }).products.find((p) => p.sponsored);
  assert.equal(ad.product_id, '987654321');
  assert.equal(ad.product_url, 'https://www.walmart.com/ip/TCL-55-Class-4K-UHD-Smart-TV/987654321');
  assert.equal(ad.price, '298.00');
});

test('each image belongs to its own card', () => {
  for (const product of scan({ includeSponsored: true }).products) {
    if (product.image_url) assert.ok(product.image_url.includes(product.product_id), `${product.product_id} -> ${product.image_url}`);
  }
});

test('stale page data that matches no visible card produces a warning', () => {
  const doc = documentFromHtml(
    `<div data-item-id="X"><a link-identifier="11111111" href="/ip/Thing/11111111"></a><span data-automation-id="product-title">Thing</span></div>
     <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"initialData":{"searchResult":{"itemStacks":[{"items":[{"usItemId":"22222222","name":"Other"}]}]}}}}}</script>`,
    URL_SEARCH,
  );
  const result = scanDocument(doc, URL_SEARCH, {});
  assert.equal(result.products.length, 1);
  assert.ok(result.warnings.some((w) => /did not match the visible results/.test(w)));
});

test('the "Robot or human?" page is reported', () => {
  const doc = documentFromHtml('<html><head><title>Robot or human?</title></head><body><div id="px-captcha"></div></body></html>', URL_SEARCH);
  const result = scanDocument(doc, URL_SEARCH, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BLOCKED_PAGE');
});

test('helpers', () => {
  assert.equal(resolveWalmartLink('/sp/track?rd=https%3A%2F%2Fwww.walmart.com%2Fip%2F1234567', URL_SEARCH).url.href, 'https://www.walmart.com/ip/1234567');
  assert.equal(resolveWalmartLink('/sp/track?x=1', URL_SEARCH), null);
  assert.equal(upgradeWalmartImageUrl('https://i5.walmartimages.com/a.jpeg?odnHeight=1'), 'https://i5.walmartimages.com/a.jpeg');
  assert.equal(upgradeWalmartImageUrl('https://i5.walmartimages.com/a.jpeg'), '');
  assert.equal(walmartAdapter.getPageType('https://www.walmart.com/search?q=tv'), 'search');
  assert.equal(walmartAdapter.getPageType('https://www.walmart.com/browse/electronics/tvs/3944_1060825'), 'listing');
  assert.equal(walmartAdapter.getPageType('https://www.walmart.com/ip/123'), 'other');
});
