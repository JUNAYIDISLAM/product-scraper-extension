import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportFileName, buildProductFolderName, makeUnique, sanitizePathSegment, shortHash, slugify,
} from '../src/utils/filename.js';

test('slugify produces lower-case ASCII words joined by dashes', () => {
  assert.equal(slugify('Samsung Galaxy S24 (256 GB)'), 'samsung-galaxy-s24-256-gb');
  assert.equal(slugify('Café Crème — Édition'), 'cafe-creme-edition');
  assert.equal(slugify('Salt & Pepper'), 'salt-and-pepper');
  assert.equal(slugify('   '), '');
  assert.equal(slugify('日本語のみ'), '');
});

test('slugify cuts long names at a word boundary', () => {
  const slug = slugify('Soundwave Wireless Headphones, Active Noise Cancelling, 40H Playtime', 40);
  assert.ok(slug.length <= 40);
  assert.equal(slug, 'soundwave-wireless-headphones-active');
  assert.ok(!slug.endsWith('-'));
});

test('sanitizePathSegment removes path separators and unsafe characters', () => {
  assert.equal(sanitizePathSegment('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizePathSegment('a\\b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
  assert.equal(sanitizePathSegment('...hidden...'), 'hidden');
  assert.equal(sanitizePathSegment(''), 'item');
  assert.equal(sanitizePathSegment('', { fallback: 'x' }), 'x');
});

test('sanitizePathSegment avoids reserved Windows device names', () => {
  assert.equal(sanitizePathSegment('CON'), '_CON');
  assert.equal(sanitizePathSegment('nul'), '_nul');
  assert.equal(sanitizePathSegment('com1.txt'), '_com1.txt');
  assert.equal(sanitizePathSegment('console'), 'console');
});

test('sanitizePathSegment enforces the maximum length', () => {
  assert.equal(sanitizePathSegment('a'.repeat(200), { maxLength: 80 }).length, 80);
});

test('product folder names combine the name slug and the product id', () => {
  assert.equal(buildProductFolderName({ product_name: 'Samsung Galaxy', product_id: '123' }), 'samsung-galaxy-123');
  assert.equal(buildProductFolderName({ product_name: 'Headphones', product_id: 'B0ABC123' }), 'headphones-B0ABC123');
});

test('URL product ids are replaced by a short hash', () => {
  const url = 'https://www.target.com/p/thing/-/A-1';
  const name = buildProductFolderName({ product_name: 'Thing', product_id: url });
  assert.equal(name, `thing-u${shortHash(url)}`);
  assert.ok(!name.includes('/'));
});

test('folder names fall back when the name has no ASCII characters', () => {
  assert.equal(buildProductFolderName({ product_name: '日本語', product_id: '42' }), '42');
  assert.match(buildProductFolderName({ product_name: '日本語', product_id: '' }), /^product-[0-9a-f]{8}$/);
});

test('makeUnique adds numeric suffixes and is case-insensitive', () => {
  const used = new Set();
  assert.equal(makeUnique('item-1', used), 'item-1');
  assert.equal(makeUnique('item-1', used), 'item-1-2');
  assert.equal(makeUnique('ITEM-1', used), 'ITEM-1-3');
});

test('export file name contains a local timestamp', () => {
  assert.equal(buildExportFileName(new Date(2026, 9, 29, 8, 5, 3)), 'multi-platform-product-export-20261029-080503.zip');
});

test('shortHash is stable', () => {
  assert.equal(shortHash('abc'), shortHash('abc'));
  assert.notEqual(shortHash('abc'), shortHash('abd'));
  assert.match(shortHash('x'), /^[0-9a-f]{8}$/);
});
