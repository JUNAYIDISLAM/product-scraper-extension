import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvValue, productsToCsv, toCsv } from '../src/services/csv-exporter.js';
import { CSV_COLUMNS } from '../src/services/product-normalizer.js';

test('plain values are not quoted', () => {
  assert.equal(escapeCsvValue('Headphones'), 'Headphones');
  assert.equal(escapeCsvValue('59.99'), '59.99');
});

test('commas, quotes and line breaks are quoted and quotes doubled', () => {
  assert.equal(escapeCsvValue('Lamp, brass'), '"Lamp, brass"');
  assert.equal(escapeCsvValue('HP 14" Laptop'), '"HP 14"" Laptop"');
  assert.equal(escapeCsvValue('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvValue('a\r\nb'), '"a\r\nb"');
});

test('leading or trailing spaces are preserved by quoting', () => {
  assert.equal(escapeCsvValue(' padded '), '" padded "');
});

test('null and undefined become empty fields', () => {
  assert.equal(escapeCsvValue(null), '');
  assert.equal(escapeCsvValue(undefined), '');
});

test('formula-like values are neutralised for spreadsheets', () => {
  assert.equal(escapeCsvValue('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
  assert.equal(escapeCsvValue('+1 Cable'), "'+1 Cable");
  assert.equal(escapeCsvValue('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(escapeCsvValue('-5 Pack'), "'-5 Pack");
  assert.equal(escapeCsvValue('=1', { protectFormulas: false }), '=1');
});

test('CSV has a UTF-8 BOM, CRLF line endings and the exact required header', () => {
  const csv = productsToCsv([]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv, '﻿platform,product_id,product_name,price,currency,product_url,image_url,image\r\n');
  assert.deepEqual(CSV_COLUMNS, ['platform', 'product_id', 'product_name', 'price', 'currency', 'product_url', 'image_url', 'image']);
});

test('rows follow column order and keep non-ASCII text intact', () => {
  const csv = toCsv(
    [{ b: 'Café “Deluxe”, 50”', a: 'x', ignored: 'y' }],
    ['a', 'b'],
    { bom: false },
  );
  assert.equal(csv, 'a,b\r\nx,"Café “Deluxe”, 50”"\r\n');
});

test('missing fields produce empty cells in the right position', () => {
  const csv = productsToCsv([{ platform: 'amazon', product_id: 'B0TEST0001', product_name: 'Name' }], { bom: false });
  assert.equal(csv.split('\r\n')[1], 'amazon,B0TEST0001,Name,,,,,');
});
