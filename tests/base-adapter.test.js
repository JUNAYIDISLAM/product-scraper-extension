import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichFromStructuredData, groupLinksIntoCards, hasSponsoredLabel, imageUrlsFromImg, jsonLdById, outermost,
  parseSrcset, readJsonLdProducts,
} from '../src/adapters/base-adapter.js';
import { documentFromHtml } from './helpers.js';

const BASE = 'https://www.example-shop.test/s?q=x';

test('parseSrcset orders candidates largest first', () => {
  const list = parseSrcset('a.jpg 1x, b.jpg 2x, c.jpg 1.5x');
  assert.deepEqual(list.map((c) => c.url), ['b.jpg', 'c.jpg', 'a.jpg']);
  assert.deepEqual(parseSrcset('s.jpg 300w,l.jpg 900w').map((c) => c.url), ['l.jpg', 's.jpg']);
  assert.deepEqual(parseSrcset(''), []);
  assert.deepEqual(parseSrcset(null), []);
});

test('imageUrlsFromImg prefers srcset, then lazy attributes, and drops placeholders', () => {
  const doc = documentFromHtml(
    `<picture><source srcset="/img/big.webp 2x"><img src="data:image/gif;base64,R0lGOD" data-src="/img/lazy.jpg" srcset="/img/small.jpg 1x"></picture>`,
    BASE,
  );
  assert.deepEqual(imageUrlsFromImg(doc.querySelector('img'), BASE), [
    'https://www.example-shop.test/img/small.jpg',
    'https://www.example-shop.test/img/big.webp',
    'https://www.example-shop.test/img/lazy.jpg',
  ]);
  assert.deepEqual(imageUrlsFromImg(null, BASE), []);
});

test('hasSponsoredLabel matches whole labels only', () => {
  const doc = documentFromHtml(
    `<div id="a"><span>Sponsored</span></div><div id="b"><h2>Team Sponsored Edition Headset</h2></div><div id="c"><span> sponsored ad </span></div>`,
    BASE,
  );
  assert.equal(hasSponsoredLabel(doc.getElementById('a')), true);
  assert.equal(hasSponsoredLabel(doc.getElementById('b')), false);
  assert.equal(hasSponsoredLabel(doc.getElementById('c')), true);
});

test('outermost drops nested matches', () => {
  const doc = documentFromHtml('<div id="o" class="c"><div id="i" class="c"></div></div><div id="s" class="c"></div>', BASE);
  assert.deepEqual(outermost([...doc.querySelectorAll('.c')]).map((e) => e.id), ['o', 's']);
});

test('groupLinksIntoCards never merges two products into one card', () => {
  const doc = documentFromHtml(
    `<ul id="grid">
       <li id="p1"><div><a href="/item/1"><img src="/1.jpg"></a></div><div><a href="/item/1">One</a><span>$1</span></div></li>
       <li id="p2"><div><a href="/item/2"><img src="/2.jpg"></a></div><div><a href="/item/2">Two</a></div></li>
     </ul>`,
    BASE,
  );
  const cards = groupLinksIntoCards(doc, 'a[href*="/item/"]', (href) => href.match(/\/item\/(\d+)/)?.[1] || '');
  assert.deepEqual(cards.map((c) => c.id), ['p1', 'p2']);
});

test('JSON-LD Product data is read from ItemList and @graph, other types are ignored', () => {
  const doc = documentFromHtml(
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
        {"@type":"ListItem","position":1,"item":{"@type":"Product","name":"Lamp","url":"https://www.example-shop.test/item/1","image":["https://img.test/1.jpg"],"offers":{"@type":"Offer","price":"19.99","priceCurrency":"USD"}}}
     ]}</script>
     <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Shop"},{"@type":"Product","name":"Mug","url":"/item/2","image":{"@type":"ImageObject","url":"https://img.test/2.jpg"}}]}</script>
     <script type="application/ld+json">{ not valid json </script>
     <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>`,
    BASE,
  );
  const products = readJsonLdProducts(doc);
  assert.deepEqual(products.map((p) => [p.name, p.image, p.priceAmount, p.currency]), [
    ['Lamp', 'https://img.test/1.jpg', 19.99, 'USD'],
    ['Mug', 'https://img.test/2.jpg', undefined, ''],
  ]);
});

test('structured data only fills missing fields of DOM cards with the same id', () => {
  const doc = documentFromHtml(
    `<script type="application/ld+json">[
       {"@type":"Product","name":"JSON name","url":"https://www.example-shop.test/item/1","image":"https://img.test/1.jpg","offers":{"price":5,"priceCurrency":"USD"}},
       {"@type":"Product","name":"Not on page","url":"https://www.example-shop.test/item/9","offers":{"price":1}}
     ]</script>`,
    BASE,
  );
  const byId = jsonLdById(doc, (url) => url.match(/\/item\/(\d+)/)?.[1] || '', BASE);
  const cards = [
    { productId: '1', name: 'DOM name', priceText: '', imageCandidates: [] },
    { productId: '2', name: 'Other', priceText: '$3.00', imageCandidates: ['https://img.test/dom2.jpg'] },
  ];
  enrichFromStructuredData(cards, byId);
  assert.equal(cards[0].name, 'DOM name');
  assert.equal(cards[0].priceAmount, 5);
  assert.deepEqual(cards[0].imageCandidates, ['https://img.test/1.jpg']);
  assert.equal(cards.length, 2, 'structured entries without a DOM card are never added');
  assert.equal(cards[1].priceText, '$3.00');
});
