import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoScroll, scanDocument } from '../src/content/scan.js';
import { documentFromHtml, loadFixture } from './helpers.js';

test('unsupported websites return a clear error', () => {
  const url = 'https://www.example.com/search?q=x';
  const result = scanDocument(documentFromHtml('<p>hello</p>', url), url, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSUPPORTED_SITE');
  assert.match(result.error.message, /Walmart, Amazon\.com, Target, Best Buy, eBay/);
});

test('non-search pages on supported sites get a warning', () => {
  const url = 'https://www.amazon.com/dp/B0TEST0001';
  const result = scanDocument(documentFromHtml('<p>product page</p>', url), url, {});
  assert.equal(result.ok, true);
  assert.equal(result.pageType, 'other');
  assert.match(result.warnings[0], /does not look like a search results page on Amazon\.com/);
});

test('adapter exceptions become SCAN_FAILED errors instead of crashing', async () => {
  const { amazonAdapter } = await import('../src/adapters/amazon-adapter.js');
  const original = amazonAdapter.extract;
  amazonAdapter.extract = () => {
    throw new Error('boom');
  };
  try {
    const url = 'https://www.amazon.com/s?k=x';
    const result = scanDocument(documentFromHtml('<p></p>', url), url, {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SCAN_FAILED');
    assert.match(result.error.message, /boom/);
  } finally {
    amazonAdapter.extract = original;
  }
});

test('scan results are plain JSON (safe to pass through extension messaging)', () => {
  const url = 'https://www.ebay.com/sch/i.html?_nkw=camera';
  const result = scanDocument(loadFixture('ebay-search.html', url), url, { limit: 25 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(Object.keys(result.products[0]).sort(), [
    'currency', 'image', 'image_candidates', 'image_url', 'platform', 'price', 'product_id', 'product_name',
    'product_url', 'sponsored', 'thumbnail_url', 'warnings',
  ]);
});

test('autoScroll is bounded and returns to the starting position', async () => {
  const calls = [];
  const win = {
    scrollY: 100,
    innerHeight: 1000,
    setTimeout: (fn) => setTimeout(fn, 0),
    scrollBy(_x, dy) {
      calls.push(dy);
      this.scrollY = Math.min(this.scrollY + dy, 3000);
    },
    scrollTo(_x, y) {
      this.scrollY = y;
    },
  };
  const { steps } = await autoScroll(win, { maxSteps: 10, delayMs: 0 });
  assert.ok(steps <= 10);
  assert.equal(steps, 4, 'stops when the bottom of the page is reached');
  assert.equal(win.scrollY, 100);
});
