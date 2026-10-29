import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildExportZip, planImageFolders } from '../src/services/zip-exporter.js';
import { ErrorCodes } from '../src/utils/errors.js';
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from './helpers.js';

const product = (overrides) => ({
  platform: 'walmart',
  product_id: '123',
  product_name: 'Samsung Galaxy',
  price: '199.00',
  currency: 'USD',
  product_url: 'https://www.walmart.com/ip/123',
  image_url: 'https://i5.walmartimages.com/seo/a.jpeg',
  image: '',
  image_candidates: ['https://i5.walmartimages.com/seo/a.jpeg'],
  ...overrides,
});

/** Parses the generated CSV (no quoted line breaks in these tests). */
function parseCsv(text) {
  assert.ok(text.startsWith('﻿'));
  const lines = text.slice(1).trimEnd().split('\r\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(current); current = ''; }
      else current += ch;
    }
    cells.push(current);
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

test('every product gets its own folder, and collisions get a suffix', () => {
  const plan = planImageFolders([
    product({ product_id: '123' }),
    product({ product_id: '123' }),
    product({ platform: 'amazon', product_id: 'B0ABC123', product_name: 'Headphones' }),
    product({ platform: 'ebay', product_id: '987654', product_name: 'Laptop' }),
  ]);
  assert.deepEqual(plan.map((p) => p.folder), [
    'images/walmart/samsung-galaxy-123',
    'images/walmart/samsung-galaxy-123-2',
    'images/amazon/headphones-B0ABC123',
    'images/ebay/laptop-987654',
  ]);
});

test('the ZIP contains products.csv, the report and one main image per product', async () => {
  const products = [
    product({ platform: 'walmart', product_id: '123', product_name: 'Samsung Galaxy', image_candidates: ['https://i5.walmartimages.com/seo/walmart.jpeg'] }),
    product({ platform: 'amazon', product_id: 'B0ABC123', product_name: 'Headphones, "Pro"', image_candidates: ['https://m.media-amazon.com/images/I/amazon.jpg'] }),
    product({ platform: 'ebay', product_id: '987654', product_name: 'Laptop', image_candidates: ['https://i.ebayimg.com/images/g/x/s-l1600.png'] }),
  ];
  const bytesFor = { walmart: JPEG_BYTES, amazon: WEBP_BYTES, ebay: PNG_BYTES };
  const extFor = { walmart: 'jpg', amazon: 'webp', ebay: 'png' };
  const progress = [];
  const result = await buildExportZip(products, {
    outputType: 'uint8array',
    downloadImage: async (candidates, platformId) => ({ ok: true, bytes: bytesFor[platformId], ext: extFor[platformId], url: candidates[0] }),
    onProgress: (p) => progress.push(p),
  });

  const zip = await JSZip.loadAsync(result.data);
  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  assert.deepEqual(files, [
    'export-report.json',
    'images/amazon/headphones-pro-B0ABC123/main.webp',
    'images/ebay/laptop-987654/main.png',
    'images/walmart/samsung-galaxy-123/main.jpg',
    'products.csv',
  ]);

  // Image bytes are stored unchanged.
  assert.deepEqual(await zip.file('images/amazon/headphones-pro-B0ABC123/main.webp').async('uint8array'), WEBP_BYTES);

  // Each CSV row points at the image that was written for the same product.
  const rows = parseCsv(await zip.file('products.csv').async('string'));
  assert.deepEqual(rows.map((r) => [r.product_id, r.image]), [
    ['123', 'images/walmart/samsung-galaxy-123/main.jpg'],
    ['B0ABC123', 'images/amazon/headphones-pro-B0ABC123/main.webp'],
    ['987654', 'images/ebay/laptop-987654/main.png'],
  ]);
  assert.equal(rows[1].product_name, 'Headphones, "Pro"');
  for (const row of rows) assert.ok(zip.file(row.image), `${row.image} exists in the ZIP`);

  assert.deepEqual(result.summary, { products: 3, imagesSaved: 3, imagesFailed: 0, failureReasons: {}, platforms: ['walmart', 'amazon', 'ebay'] });
  assert.equal(progress.at(-1).percent, 100);
  assert.ok(progress.some((p) => p.phase === 'images' && p.completed === 3));
});

test('failed image downloads leave an empty image path and do not stop the export', async () => {
  const products = [
    product({ product_id: '1', product_name: 'Works' }),
    product({ product_id: '2', product_name: 'Broken image' }),
    product({ product_id: '3', product_name: 'No image', image_url: '', image_candidates: [] }),
    product({ product_id: '4', product_name: 'Throws' }),
  ];
  const result = await buildExportZip(products, {
    outputType: 'uint8array',
    downloadImage: async (candidates, platformId) => {
      if (!candidates.length) return { ok: false, error: { code: ErrorCodes.IMAGE_MISSING, message: 'No image URL was found for this product' } };
      if (products.findIndex((p) => p.image_candidates === candidates) === 1) return { ok: false, error: { code: ErrorCodes.IMAGE_HTTP_ERROR, message: 'HTTP 404' } };
      if (products.findIndex((p) => p.image_candidates === candidates) === 3) throw new Error('unexpected crash');
      return { ok: true, bytes: JPEG_BYTES, ext: 'jpg', url: candidates[0], platformId };
    },
  });
  const zip = await JSZip.loadAsync(result.data);
  const rows = parseCsv(await zip.file('products.csv').async('string'));
  assert.deepEqual(rows.map((r) => r.image), ['images/walmart/works-1/main.jpg', '', '', '']);
  assert.equal(rows[1].image_url, 'https://i5.walmartimages.com/seo/a.jpeg');
  assert.equal(result.summary.imagesSaved, 1);
  assert.equal(result.summary.imagesFailed, 3);
  assert.deepEqual(result.summary.failureReasons, { 'HTTP 404': 1, 'No image URL was found for this product': 1, 'unexpected crash': 1 });

  const report = JSON.parse(await zip.file('export-report.json').async('string'));
  assert.equal(report.imageFailures.length, 3);
  assert.ok(report.imageFailures.every((f) => f.product_id && f.reason));
});

test('exporting nothing is an error', async () => {
  await assert.rejects(buildExportZip([], { downloadImage: async () => ({ ok: false }) }), { code: ErrorCodes.NO_PRODUCTS });
});
