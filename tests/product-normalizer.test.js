import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeProducts, normalizeLimit, normalizeProduct, normalizeProductUrl, normalizeScanResult, parsePrice,
  priceFromNumber, sanitizeProductForExport, sanitizeProductId,
} from '../src/services/product-normalizer.js';
import { PLATFORMS } from '../src/adapters/platforms.js';

const amazon = PLATFORMS.amazon;

test('parsePrice handles US formats', () => {
  assert.deepEqual(parsePrice('$59.99', 'USD'), { price: '59.99', currency: 'USD' });
  assert.deepEqual(parsePrice('$1,299.00', 'USD'), { price: '1299.00', currency: 'USD' });
  assert.deepEqual(parsePrice('$24', 'USD'), { price: '24.00', currency: 'USD' });
  assert.deepEqual(parsePrice('current price Now $198.00', 'USD'), { price: '198.00', currency: 'USD' });
  assert.deepEqual(parsePrice('US $12.50', 'USD'), { price: '12.50', currency: 'USD' });
});

test('parsePrice keeps the first price when several are shown', () => {
  assert.deepEqual(parsePrice('$198.00 Was $248.00', 'USD'), { price: '198.00', currency: 'USD' });
});

test('parsePrice recognises ranges', () => {
  assert.deepEqual(parsePrice('$12.99 - $24.99', 'USD'), { price: '12.99 - 24.99', currency: 'USD' });
  assert.deepEqual(parsePrice('$12.99 to $24.99', 'USD'), { price: '12.99 - 24.99', currency: 'USD' });
  assert.deepEqual(parsePrice('Options from $12.99 – $24.99', 'USD'), { price: '12.99 - 24.99', currency: 'USD' });
});

test('parsePrice detects other currencies', () => {
  assert.deepEqual(parsePrice('C $45.00', 'USD'), { price: '45.00', currency: 'CAD' });
  assert.deepEqual(parsePrice('GBP 10.00', 'USD'), { price: '10.00', currency: 'GBP' });
  assert.deepEqual(parsePrice('EUR 12,34', 'USD'), { price: '12.34', currency: 'EUR' });
  assert.deepEqual(parsePrice('12,34 €', 'USD'), { price: '12.34', currency: 'EUR' });
  assert.deepEqual(parsePrice('¥1,500', 'USD'), { price: '1500', currency: 'JPY' });
});

test('parsePrice never invents prices from text without a currency', () => {
  assert.deepEqual(parsePrice('4.5 out of 5 stars', 'USD'), { price: '', currency: '' });
  assert.deepEqual(parsePrice('See price in cart', 'USD'), { price: '', currency: '' });
  assert.deepEqual(parsePrice('', 'USD'), { price: '', currency: '' });
  assert.deepEqual(parsePrice(undefined, 'USD'), { price: '', currency: '' });
});

test('letters before "$" are not mistaken for currency prefixes', () => {
  assert.deepEqual(parsePrice('Classic $5.00', 'USD'), { price: '5.00', currency: 'USD' });
  assert.deepEqual(parsePrice('music $5', 'USD'), { price: '5.00', currency: 'USD' });
});

test('priceFromNumber formats structured prices', () => {
  assert.deepEqual(priceFromNumber(129.99, 'USD'), { price: '129.99', currency: 'USD' });
  assert.deepEqual(priceFromNumber(198, 'USD'), { price: '198.00', currency: 'USD' });
  assert.deepEqual(priceFromNumber(-1, 'USD'), { price: '', currency: '' });
  assert.deepEqual(priceFromNumber(Number.NaN, 'USD'), { price: '', currency: '' });
});

test('sanitizeProductId accepts native ids only', () => {
  assert.equal(sanitizeProductId(' B0TEST0001 '), 'B0TEST0001');
  assert.equal(sanitizeProductId('123456789'), '123456789');
  assert.equal(sanitizeProductId('a b'), '');
  assert.equal(sanitizeProductId('<script>'), '');
  assert.equal(sanitizeProductId(''), '');
});

test('normalizeProductUrl only accepts HTTPS URLs on the platform domain', () => {
  assert.equal(normalizeProductUrl('https://www.amazon.com/dp/B0TEST0001#reviews', 'amazon'), 'https://www.amazon.com/dp/B0TEST0001');
  assert.equal(normalizeProductUrl('http://www.amazon.com/dp/B0TEST0001', 'amazon'), 'https://www.amazon.com/dp/B0TEST0001');
  assert.equal(normalizeProductUrl('https://www.amazon.com.evil.example/dp/B0', 'amazon'), '');
  assert.equal(normalizeProductUrl('javascript:alert(1)', 'amazon'), '');
  assert.equal(normalizeProductUrl('https://www.walmart.com/ip/1', 'amazon'), '');
  assert.equal(normalizeProductUrl('', 'amazon'), '');
});

const rawCard = (overrides = {}) => ({
  productId: 'B0TEST0001',
  name: '  Soundwave   Headphones ',
  url: 'https://www.amazon.com/dp/B0TEST0001',
  priceText: '$59.99',
  imageCandidates: ['https://m.media-amazon.com/images/I/61img0001.jpg', 'https://m.media-amazon.com/images/I/61img0001._AC_UY218_.jpg'],
  thumbnailUrl: 'https://m.media-amazon.com/images/I/61img0001._AC_UY218_.jpg',
  ...overrides,
});

test('normalizeProduct builds the common product model', () => {
  const { product } = normalizeProduct(rawCard(), amazon);
  assert.deepEqual(
    {
      platform: product.platform,
      product_id: product.product_id,
      product_name: product.product_name,
      price: product.price,
      currency: product.currency,
      product_url: product.product_url,
      image_url: product.image_url,
      image: product.image,
    },
    {
      platform: 'amazon',
      product_id: 'B0TEST0001',
      product_name: 'Soundwave Headphones',
      price: '59.99',
      currency: 'USD',
      product_url: 'https://www.amazon.com/dp/B0TEST0001',
      image_url: 'https://m.media-amazon.com/images/I/61img0001.jpg',
      image: '',
    },
  );
  assert.equal(product.thumbnail_url, 'https://m.media-amazon.com/images/I/61img0001._AC_UY218_.jpg');
});

test('missing price and image are allowed but reported', () => {
  const { product } = normalizeProduct(rawCard({ priceText: '', imageCandidates: [], thumbnailUrl: '' }), amazon);
  assert.equal(product.price, '');
  assert.equal(product.currency, '');
  assert.equal(product.image_url, '');
  assert.ok(product.warnings.some((w) => /no main image/i.test(w)));
  assert.ok(product.warnings.some((w) => /no price/i.test(w)));
});

test('a missing product id falls back to the product URL', () => {
  const { product } = normalizeProduct(rawCard({ productId: '' }), amazon);
  assert.equal(product.product_id, 'https://www.amazon.com/dp/B0TEST0001');
});

test('cards without a name, or without id and URL, are skipped with a reason', () => {
  assert.equal(normalizeProduct(rawCard({ name: '   ' }), amazon).skip.reason, 'Missing product name');
  assert.equal(normalizeProduct(rawCard({ productId: '', url: '' }), amazon).skip.reason, 'Missing product ID and product link');
  assert.match(normalizeProduct(rawCard({ url: 'https://ads.example.com/x' }), amazon).skip.reason, /does not point to Amazon/);
  assert.equal(normalizeProduct(null, amazon).skip.reason, 'Card data could not be read');
});

test('image URLs on hosts outside the allow-list are dropped', () => {
  const { product } = normalizeProduct(
    rawCard({ imageCandidates: ['https://tracker.example.com/pixel.jpg', 'data:image/gif;base64,AAAA', 'https://m.media-amazon.com/images/I/ok.jpg'] }),
    amazon,
  );
  assert.deepEqual(product.image_candidates, ['https://m.media-amazon.com/images/I/ok.jpg']);
  assert.ok(product.warnings.some((w) => w.includes('tracker.example.com')));
});

test('structured numeric prices are used only when no visible price exists', () => {
  assert.equal(normalizeProduct(rawCard({ priceText: '', priceAmount: 129.99, currency: 'USD' }), amazon).product.price, '129.99');
  assert.equal(normalizeProduct(rawCard({ priceText: '$10.00', priceAmount: 99 }), amazon).product.price, '10.00');
});

test('dedupeProducts keeps the first occurrence of each platform + id', () => {
  const a = { platform: 'amazon', product_id: '1', product_name: 'first' };
  const b = { platform: 'amazon', product_id: '1', product_name: 'second' };
  const c = { platform: 'ebay', product_id: '1', product_name: 'other platform' };
  const { unique, duplicates } = dedupeProducts([a, b, c]);
  assert.deepEqual(unique, [a, c]);
  assert.deepEqual(duplicates, [b]);
});

test('normalizeScanResult filters sponsored, dedupes, reports skips and applies the limit', () => {
  const cards = [
    rawCard(),
    rawCard({ productId: 'B0TEST0002', url: 'https://www.amazon.com/dp/B0TEST0002', sponsored: true }),
    rawCard(),
    rawCard({ productId: 'B0TEST0003', url: 'https://www.amazon.com/dp/B0TEST0003', name: '' }),
    ...Array.from({ length: 12 }, (_, i) => rawCard({ productId: `B0BULK${String(i).padStart(4, '0')}`, url: `https://www.amazon.com/dp/B0BULK${String(i).padStart(4, '0')}` })),
  ];
  const result = normalizeScanResult({ cards, skipped: [{ reason: 'Adapter skip' }], warnings: ['w'] }, amazon, { limit: 10 });
  assert.equal(result.cardsFound, 17);
  assert.equal(result.detectedCount, 13);
  assert.equal(result.products.length, 10);
  assert.equal(result.sponsoredCount, 1);
  assert.deepEqual(result.warnings, ['w']);
  assert.equal(result.skippedSummary['Duplicate of a product already listed'], 1);
  assert.equal(result.skippedSummary['Missing product name'], 1);
  assert.equal(result.skippedSummary['Adapter skip'], 1);
  assert.equal(result.skippedSummary['Sponsored listing (enable "Include sponsored" to keep it)'], 1);

  const withAds = normalizeScanResult({ cards, skipped: [], warnings: [] }, amazon, { limit: 100, includeSponsored: true });
  assert.equal(withAds.detectedCount, 14);
  assert.ok(withAds.products.some((p) => p.sponsored));
});

test('empty extraction results are handled', () => {
  const result = normalizeScanResult({ cards: [], skipped: [], warnings: [] }, amazon, {});
  assert.equal(result.detectedCount, 0);
  assert.deepEqual(result.products, []);
  assert.equal(normalizeScanResult(undefined, amazon).products.length, 0);
});

test('normalizeLimit clamps invalid values', () => {
  assert.equal(normalizeLimit(50), 50);
  assert.equal(normalizeLimit(1000), 100);
  assert.equal(normalizeLimit('abc'), 25);
  assert.equal(normalizeLimit(0), 25);
});

test('sanitizeProductForExport re-validates every field', () => {
  const clean = sanitizeProductForExport({
    platform: 'amazon',
    product_id: 'B0TEST0001',
    product_name: 'Name\u0000 with control',
    price: '59.99',
    currency: 'USD',
    product_url: 'https://www.amazon.com/dp/B0TEST0001',
    image_candidates: ['https://evil.example/x.jpg', 'https://m.media-amazon.com/images/I/a.jpg'],
    extra: 'dropped',
  });
  assert.deepEqual(clean, {
    platform: 'amazon',
    product_id: 'B0TEST0001',
    product_name: 'Name with control',
    price: '59.99',
    currency: 'USD',
    product_url: 'https://www.amazon.com/dp/B0TEST0001',
    image_url: 'https://m.media-amazon.com/images/I/a.jpg',
    image: '',
    image_candidates: ['https://m.media-amazon.com/images/I/a.jpg'],
  });
});

test('sanitizeProductForExport rejects unknown platforms and bad data', () => {
  assert.equal(sanitizeProductForExport({ platform: 'evilshop', product_id: '1', product_name: 'x' }), null);
  assert.equal(sanitizeProductForExport({ platform: 'amazon', product_id: '', product_name: 'x' }), null);
  assert.equal(sanitizeProductForExport({ platform: 'amazon', product_id: '1', product_name: '' }), null);
  assert.equal(sanitizeProductForExport('nope'), null);
  const weird = sanitizeProductForExport({ platform: 'amazon', product_id: '1', product_name: 'x', price: '=1+1', currency: 'dollars', product_url: 'javascript:alert(1)' });
  assert.equal(weird.price, '');
  assert.equal(weird.currency, '');
  assert.equal(weird.product_url, '');
});
