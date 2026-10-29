import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ebayAdapter, ebayItemIdFromHref, upgradeEbayImageUrl } from '../../src/adapters/ebay-adapter.js';
import { scanDocument } from '../../src/content/scan.js';
import { documentFromHtml, loadFixture } from '../helpers.js';

const URL_SEARCH = 'https://www.ebay.com/sch/i.html?_nkw=camera';
const scan = (options = {}) => scanDocument(loadFixture('ebay-search.html', URL_SEARCH), URL_SEARCH, { limit: 100, ...options });

test('detects listings from both layouts and skips the placeholder card', () => {
  const result = scan();
  assert.equal(result.ok, true);
  assert.deepEqual(result.products.map((p) => p.product_id), ['256000000001', '256000000002', '256000000003', '256000000005']);
  assert.equal(result.skippedSummary['eBay placeholder card ("Shop on eBay")'], 1);
  assert.equal(result.skippedSummary['Card has no eBay item id'], 1);
  assert.equal(result.skippedSummary['Duplicate of a product already listed'], 1);
});

test('cleans titles and uses lazy-loaded image URLs', () => {
  const [canon] = scan().products;
  assert.equal(canon.product_name, 'Canon EOS Rebel T7 DSLR Camera with 18-55mm Lens');
  assert.equal(canon.price, '299.99');
  assert.equal(canon.product_url, 'https://www.ebay.com/itm/256000000001');
  assert.equal(canon.image_url, 'https://i.ebayimg.com/images/g/AbCd0001/s-l1600.webp');
  assert.equal(canon.thumbnail_url, 'https://i.ebayimg.com/images/g/AbCd0001/s-l140.webp');
});

test('price ranges and other currencies', () => {
  const byId = Object.fromEntries(scan().products.map((p) => [p.product_id, p]));
  assert.equal(byId['256000000002'].price, '12.99 - 24.99');
  assert.equal(byId['256000000002'].image_url, 'https://i.ebayimg.com/images/g/EfGh0002/s-l1600.jpg');
  assert.deepEqual([byId['256000000003'].price, byId['256000000003'].currency], ['45.00', 'CAD']);
});

test('newer layout ignores the struck-through original price', () => {
  const sony = scan().products.find((p) => p.product_id === '256000000005');
  assert.equal(sony.product_name, 'Sony Alpha a6000 Mirrorless Camera Body');
  assert.equal(sony.price, '350.00');
  assert.equal(sony.image_url, 'https://i.ebayimg.com/images/g/MnOp0005/s-l1600.jpg');
});

test('each image belongs to its own card', () => {
  for (const product of scan().products) {
    assert.ok(product.image_url.includes(`000${product.product_id.slice(-1)}/`), `${product.product_id} -> ${product.image_url}`);
  }
});

test('warns that eBay sponsored labels cannot be detected reliably', () => {
  assert.ok(scan().warnings.some((w) => /promoted listings may not be filtered/.test(w)));
});

test('the "Pardon our interruption" page is reported', () => {
  const doc = documentFromHtml('<html><head><title>Pardon Our Interruption...</title></head><body></body></html>', URL_SEARCH);
  assert.equal(scanDocument(doc, URL_SEARCH, {}).error.code, 'BLOCKED_PAGE');
});

test('helpers', () => {
  assert.equal(ebayItemIdFromHref('https://www.ebay.com/itm/256000000001?hash=1'), '256000000001');
  assert.equal(ebayItemIdFromHref('https://www.ebay.com/itm/Some-Title/256000000002'), '256000000002');
  assert.equal(ebayItemIdFromHref('https://www.ebay.com/sch/i.html'), '');
  assert.equal(upgradeEbayImageUrl('https://i.ebayimg.com/images/g/x/s-l225.webp'), 'https://i.ebayimg.com/images/g/x/s-l1600.webp');
  assert.equal(upgradeEbayImageUrl('https://i.ebayimg.com/00/s/MTYwMA==/z/x/$_57.JPG'), '');
  assert.equal(ebayAdapter.getPageType(URL_SEARCH), 'search');
});
