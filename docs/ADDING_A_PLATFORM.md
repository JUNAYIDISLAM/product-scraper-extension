# Adding a new platform

Each website has its own adapter. An adapter reads one search results document and returns
**raw cards**. Everything else (normalisation, dedup, CSV, images, ZIP, UI) is shared and
needs no changes.

The example below adds a fictional store, `www.examplemart.com`, whose images are served
from `img.examplemart-cdn.com`.

## 1. Describe the platform (`src/adapters/platforms.js`)

```js
examplemart: Object.freeze({
  id: 'examplemart',                       // lower-case; used in the CSV and in image folder names
  name: 'ExampleMart',                     // shown in the popup
  pageHosts: Object.freeze(['www.examplemart.com', 'examplemart.com']),  // exact hostnames
  imageHosts: Object.freeze(['img.examplemart-cdn.com']),               // exact HTTPS image hosts
  defaultCurrency: 'USD',                  // what a bare "$" means on this site
  origin: 'https://www.examplemart.com',   // used to build canonical product URLs
}),
```

Use exact hostnames only, never wildcards. Image URLs on any other host are dropped and reported.

## 2. Allow its image host (`manifest.json`)

Add every `imageHosts` entry to `optional_host_permissions`:

```json
"optional_host_permissions": [
  "...existing hosts...",
  "https://img.examplemart-cdn.com/*"
]
```

The test `manifest optional host permissions match the platform image hosts exactly` fails
until `platforms.js` and the manifest agree. You do **not** need host permission for the store
pages themselves: `activeTab` covers the tab the user clicked on.

## 3. Write the adapter (`src/adapters/examplemart-adapter.js`)

```js
import {
  BaseAdapter, textOf, firstText, firstMatch, imageUrlsFromImg, thumbnailFromImg,
  hasSponsoredLabel, outermost, uniqueStrings,
} from './base-adapter.js';
import { PLATFORMS } from './platforms.js';
import { parseUrl } from '../utils/url.js';

const CARD_SELECTOR = 'li[data-product-id]';

export function examplemartIdFromHref(href) {
  return String(href ?? '').match(/\/product\/(\d{4,})(?:[/?#]|$)/)?.[1] || '';
}

export class ExampleMartAdapter extends BaseAdapter {
  constructor() {
    super(PLATFORMS.examplemart);
  }

  getPageType(url) {
    return parseUrl(url)?.pathname === '/search' ? 'search' : 'other';
  }

  extract(doc, { pageUrl }) {
    const cards = [];
    const skipped = [];
    const warnings = [];

    for (const card of outermost([...doc.querySelectorAll(CARD_SELECTOR)])) {
      // Read EVERY field from inside `card`, never from a separate list of
      // names or images: that is what keeps the name, price and image together.
      const link = firstMatch(card, ['a.product-title[href]', 'a[href*="/product/"]']);
      const id = card.getAttribute('data-product-id') || examplemartIdFromHref(link?.getAttribute('href'));
      const name = firstText(card, ['.product-title']);
      if (!link || !id) {
        skipped.push({ reason: 'Card has no product link', name });
        continue;
      }
      const img = card.querySelector('img.product-image');
      cards.push({
        productId: id,
        name,
        url: `${this.platform.origin}/product/${id}`,       // canonical, no tracking parameters
        priceText: textOf(card.querySelector('.price-now')), // visible text; parsing happens later
        imageCandidates: uniqueStrings([/* bigger version first, if you can build one */ ...imageUrlsFromImg(img, pageUrl)]),
        thumbnailUrl: thumbnailFromImg(img, pageUrl),
        sponsored: hasSponsoredLabel(card),
      });
    }
    return { cards, skipped, warnings };
  }
}

export const exampleMartAdapter = new ExampleMartAdapter();
```

Things to get right:

- **Pick the card container first**, then read fields inside it. Use `outermost()` when the
  card selector can also match nested elements.
- **Prefer stable hooks.** Use `data-*` attributes, ids in URLs and `aria-*` attributes rather
  than generated class names like `styles_x7Fq2`. If the site has no stable container, use
  `groupLinksIntoCards(doc, linkSelector, idFromHref)` (see the Target and Best Buy adapters).
- **Price.** Pass the visible current-price text as `priceText`. Skip struck-through and unit
  prices. Leave it empty rather than guessing. Structured numeric prices go in `priceAmount`
  and `currency`.
- **Image quality.** Put the best URL first in `imageCandidates` and the card's own image
  after it as a fallback (see `upgradeAmazonImageUrl`, `upgradeEbayImageUrl`).
- **Structured data.** `enrichFromStructuredData(cards, jsonLdById(doc, idFromUrl, pageUrl))`
  fills *missing* fields from JSON-LD Products that match a card by id. It never adds products.
- **Block pages.** Override `detectBlockPage(doc)` if the site has its own CAPTCHA or "access
  denied" page, and return a message. Never try to get around it.
- **Report, don't hide.** Push skipped cards with a reason. Push a warning when you fall back
  to a less reliable strategy.

## 4. Register it (`src/adapters/adapter-registry.js`)

```js
import { exampleMartAdapter } from './examplemart-adapter.js';
export const ADAPTERS = Object.freeze([walmartAdapter, amazonAdapter, targetAdapter, bestBuyAdapter, ebayAdapter, exampleMartAdapter]);
```

## 5. Test it

1. Capture a real results page (see docs/TESTING.md), trim it to a few representative cards
   (a normal one, a sponsored one, one without a price, one without an image), and save it as
   `tests/fixtures/examplemart-search.html`.
2. Copy `tests/adapters/ebay.test.js` to `tests/adapters/examplemart.test.js` and change the
   expectations. At a minimum, assert the ids in page order, every field of one card, and that
   each image URL belongs to its own card.
3. Run `npm test`, then `npm run build`, reload the extension, and go through the manual
   checklist for the new site.
4. Add the platform to the README tables. Mark it "Tested on the live website" only after the
   manual checklist passes.
