import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestBuyAdapter, bestBuySkuFromHref, upgradeBestBuyImageUrl } from '../../src/adapters/bestbuy-adapter.js';
import { scanDocument } from '../../src/content/scan.js';
import { documentFromHtml, loadFixture } from '../helpers.js';

const URL_SEARCH = 'https://www.bestbuy.com/site/searchpage.jsp?st=laptop';
const scan = (options = {}) => scanDocument(loadFixture('bestbuy-search.html', URL_SEARCH), URL_SEARCH, { limit: 100, ...options });

test('detects classic and newer card layouts', () => {
  const result = scan();
  assert.equal(result.ok, true);
  assert.deepEqual(result.products.map((p) => p.product_id), ['6500001', '6500002', '6500003']);
});

test('classic card: customer price only, original image, canonical URL', () => {
  const [hp] = scan().products;
  assert.equal(hp.product_name, 'HP - 14" Laptop - Intel Celeron - 4GB Memory - 64GB eMMC - Snowflake White');
  assert.equal(hp.price, '179.99');
  assert.equal(hp.product_url, 'https://www.bestbuy.com/site/hp-14-laptop-intel-celeron/6500001.p?skuId=6500001');
  assert.equal(hp.image_url, 'https://pisces.bbystatic.com/image2/BestBuy_US/images/products/6500/6500001_sd.jpg');
});

test('sold-out card without a price keeps an empty price', () => {
  const lenovo = scan().products.find((p) => p.product_id === '6500002');
  assert.equal(lenovo.price, '');
  assert.equal(lenovo.currency, '');
});

test('newer card layout', () => {
  const mac = scan().products.find((p) => p.product_id === '6500003');
  assert.equal(mac.product_name, 'Apple - MacBook Air 13-inch Laptop - M3 chip - 16GB Memory - 256GB SSD - Midnight');
  assert.equal(mac.price, '899.00');
  assert.equal(mac.product_url, 'https://www.bestbuy.com/product/apple-macbook-air-13-inch-m3/J3X2ABCDEF/sku/6500003');
  assert.equal(mac.image_url, 'https://pisces.bbystatic.com/image2/BestBuy_US/images/products/6500/6500003_sd.jpg');
});

test('each image belongs to its own card', () => {
  for (const product of scan().products) assert.ok(product.image_url.includes(`${product.product_id}_sd`), product.product_id);
});

test('the country selection page is reported', () => {
  const doc = documentFromHtml('<html><head><title>Best Buy International: Select your Country</title></head><body><div class="country-selection"></div></body></html>', URL_SEARCH);
  const result = scanDocument(doc, URL_SEARCH, {});
  assert.equal(result.ok, false);
  assert.match(result.error.message, /country selection/);
});

test('the Access Denied page is reported', () => {
  const doc = documentFromHtml('<html><head><title>Access Denied</title></head><body>You don\'t have permission to access this page.</body></html>', URL_SEARCH);
  assert.equal(scanDocument(doc, URL_SEARCH, {}).error.code, 'BLOCKED_PAGE');
});

test('helpers', () => {
  assert.equal(bestBuySkuFromHref('/site/x/6500001.p?skuId=6500001'), '6500001');
  assert.equal(bestBuySkuFromHref('/site/x/6500001.p'), '6500001');
  assert.equal(bestBuySkuFromHref('/product/x/ABC/sku/6500003'), '6500003');
  assert.equal(bestBuySkuFromHref('/site/promo/deals'), '');
  assert.equal(upgradeBestBuyImageUrl('https://pisces.bbystatic.com/a/1_sd.jpg;maxHeight=1;maxWidth=1'), 'https://pisces.bbystatic.com/a/1_sd.jpg');
  assert.equal(upgradeBestBuyImageUrl('https://pisces.bbystatic.com/a/1_sd.jpg'), '');
  assert.equal(bestBuyAdapter.getPageType(URL_SEARCH), 'search');
});
