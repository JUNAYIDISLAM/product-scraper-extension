# Testing

There are three kinds of testing, and they prove different things:

| | Unit tests (`npm test`) | Browser smoke test (`npm run test:e2e`, optional) | Live website testing (manual) |
|---|---|---|---|
| Runs against | Hand-written HTML fixtures in `tests/fixtures/` and mocked network responses, in Node.js | The **built extension** in a real Chrome for Testing, with the fixture pages and locally answered image requests | The real Walmart, Amazon, Target, Best Buy and eBay pages in your Chrome |
| Proves | The logic is correct: CSV escaping, file names, price parsing, dedup, the ZIP layout, image validation, and that each adapter reads the markup it was written for | The Chrome wiring works: popup, content-script injection and messaging, service worker, offscreen document, ZIP download, progress, and closing the popup mid-export | The adapters' selectors still match the sites' current markup, and the permission prompt and toolbar click work |
| Status | 125 tests passing | 30 checks passing (Amazon and eBay fixtures, unsupported site) | **Not yet done** for any platform. Use the checklist below. |

The fixtures follow each site's card markup, but they are **not** captures of the live sites.
Passing automated tests does **not** mean a platform works today.

---

## Automated tests

```powershell
npm test
```

| Area | File | Covers |
|------|------|--------|
| CSV escaping | `tests/csv-exporter.test.js` | Commas, quotes, line breaks, leading/trailing spaces, empty fields, UTF-8 BOM, CRLF, exact header, formula-injection guard |
| Filename sanitisation | `tests/filename.test.js` | Slugs, unsafe characters, `../` traversal, Windows reserved names (`CON`, `NUL`, …), length limits, case-insensitive uniqueness, URL-only ids |
| Product normalisation | `tests/product-normalizer.test.js` | Price formats (ranges, thousands separators, decimal commas, CAD/GBP/EUR/JPY), never inventing prices, URL validation, missing fields, skip reasons, sponsored filtering, limits, strict re-validation before export |
| Deduplication | `tests/product-normalizer.test.js` and the adapter tests | Same platform + id is kept once; the same id on another platform is kept |
| Image downloads | `tests/image-downloader.test.js` | Host allow-list, missing permission, HTTP errors, wrong content type, non-image bodies, redirects off the allow-list, size limit, timeout, network errors, retry policy, fallback to the next candidate, products without images |
| ZIP entry paths | `tests/zip-exporter.test.js` | Folder per product, collision suffixes, CSV `image` column matching the files written, original image bytes, failed downloads leaving empty paths without stopping the export, report contents |
| Unsupported websites | `tests/platforms.test.js`, `tests/scan.test.js` | Unsupported and look-alike hosts, non-HTTPS pages, `chrome://` URLs, manifest permissions matching the platform image hosts |
| Empty results | `tests/adapters/amazon.test.js`, `tests/product-normalizer.test.js` | No cards on the page gives an empty list plus a layout warning |
| Adapters | `tests/adapters/*.test.js` | Each adapter on its fixture: fields, canonical URLs, image upgrades, image-to-card pairing, sponsored handling, placeholders, block/CAPTCHA pages, fallbacks |
| Shared helpers | `tests/base-adapter.test.js` | srcset parsing, lazy-image attributes, sponsored labels, link-grouping fallback, JSON-LD (only Products, only for cards on the page) |

`npm run build` also validates the built extension: manifest structure and permissions, that
every referenced file exists, that icons are PNGs of the right size, that the HTML loads no
remote or inline scripts, and that every bundled script parses.

---

## Browser smoke test (optional)

`tests/e2e/browser-smoke.mjs` loads `dist/` into Chrome for Testing (headless) and drives the
real extension. It is not part of `npm test`, because it needs a browser download of about
170 MB.

One-time setup, from the project folder:

```powershell
npm install --no-save puppeteer-core@24 @puppeteer/browsers@2
npx @puppeteer/browsers install chrome@stable --path .e2e/browsers
```

Run it after each build:

```powershell
npm run build
npm run test:e2e
```

It checks:

- The popup preview: detected count, platform badge, selection, and button labels.
- That the popup stays within Chrome's 600 px popup height, both in preview and after an export.
- A full export through the service worker, the offscreen document and `chrome.downloads`:
  the ZIP name, the BOM, the rows in page order, each `image` path existing in the ZIP, the
  upgraded image URL, `.png` kept for PNGs, and empty paths for an HTTP 404 and for a
  product with no image.
- That the export still finishes when the popup is closed right after clicking Export, and
  that the reopened popup shows the result and can dismiss it.
- The unsupported-site message, with the export buttons disabled.

Screenshots are written to `.e2e/screenshots/`.

What it **cannot** check: automation cannot click the toolbar icon or answer Chrome's
permission prompt. So the test copy of the extension has host permissions pre-granted, and
the popup is opened in a tab. The toolbar click (`activeTab`) and the permission prompt are
covered by the manual checklist below. No real website is contacted.

---

## Checking an adapter against a real page without Chrome

1. Open a search results page in Chrome and scroll to the bottom so lazy cards render.
2. Press **F12**, open the **Console**, and run:
   ```js
   copy(document.documentElement.outerHTML)
   ```
3. Paste into a new file, for example `C:\temp\amazon.html` (Notepad → Save as → Encoding UTF-8).
4. Run:
   ```powershell
   npm run try-adapter -- C:\temp\amazon.html "https://www.amazon.com/s?k=headphones"
   ```
   It prints a table of the detected products, the skipped cards with reasons, and the warnings.
   Compare it with what the page shows. Add `--json` for the full output.

A captured page that works well (after removing anything personal) makes a good new fixture
in `tests/fixtures/`.

---

## Manual live-testing checklist

Do this for each platform after installing the build (`npm run build`, then Load unpacked
`dist/`). Record the date, the Chrome version and the search term you used.

### Common checks (every platform)

- [ ] On a non-supported site (for example `https://example.com`) the popup says the site is unsupported and the export buttons are disabled.
- [ ] On `chrome://extensions` the popup says Chrome does not allow reading the page.
- [ ] On the platform's home page (not a search page) the popup warns that it does not look like a search results page.
- [ ] On a search results page the platform badge, the page URL and "N detected · showing M" are correct.
- [ ] Compare the first 10 preview rows with the page: **name, price and thumbnail belong to the same product**, in the same order as the page.
- [ ] Open 3 products' URLs (hover the ID in the preview, or open them from the CSV): each one opens the right product.
- [ ] Ads are hidden by default; with **Include sponsored** they appear with a "Sponsored" tag (not expected to work on eBay).
- [ ] Changing **Show up to** (10/25/50/100) changes the number of rows; 100 does not exceed what is on the page.
- [ ] **Select all / Deselect all**, the header checkbox and the individual checkboxes update "x of y selected" and the button counts.
- [ ] **Export selected** with 3 products: Chrome asks for image permission the first time; after **Allow**, the ZIP downloads.
- [ ] In the ZIP, `products.csv` has 3 rows. Each `image` path exists in the ZIP and shows the **same product** as that row.
- [ ] The images are larger than the page thumbnails (check the dimensions in the file properties).
- [ ] Open `products.csv` in Excel: special characters (™, ”, é) look right and prices are in the `price` column.
- [ ] Deny the image permission (remove it in `chrome://extensions` → Details → Site access, then export and click Deny): the ZIP still has `products.csv`, the image paths are empty, and the popup explains why.
- [ ] Start an export of 50 products and close the popup right away. Reopen it: the progress or the finished result is shown, and the ZIP arrives.
- [ ] Run two exports one after the other. Both ZIPs are saved, the second with a new timestamp.
- [ ] If the site shows a CAPTCHA or verification page, the popup reports it and does not try to get past it.

### Walmart (`https://www.walmart.com/search?q=tv`)

- [ ] The prices match the large price on each card, not the struck-through "Was" price or the unit price (for example "16.6 ¢/oz").
- [ ] "Options from $X – $Y" products export as a range.
- [ ] Sponsored cards (labelled "Sponsored") are hidden by default and their URLs are normal `/ip/...` product URLs.
- [ ] Image files are the full-size images (the URL has no `odnHeight` parameter).
- [ ] Also try a category page (for example Electronics → TVs) and check that the category-page warning appears.

### Amazon.com (`https://www.amazon.com/s?k=wireless+headphones`)

- [ ] Prices are the main price, not the struck-through "List:" or "Typical:" price, and not "$X (N used & new offers)".
- [ ] Products with "No featured offers available" have an empty price.
- [ ] Fashion searches (for example `s?k=t-shirt`) show the brand line before the title.
- [ ] Sponsored results are hidden by default.
- [ ] `product_url` is `https://www.amazon.com/dp/<ASIN>`.
- [ ] Image URLs have no `._AC_…_` size modifier and the images are high resolution.

### Target (`https://www.target.com/s?searchTerm=lamp`)

- [ ] Right after the page loads, only some cards are detected and the rest appear as "Card not loaded yet". After **Load more**, more cards are detected.
- [ ] Price ranges ("$19.99 - $29.99") export as ranges; "See price in cart" gives an empty price.
- [ ] "Sponsored" cards are hidden by default.
- [ ] Image URLs contain `wid=1200&hei=1200`.
- [ ] If the warning "located by their product links (fallback mode)" appears, check names and images extra carefully: the card markup has changed.

### Best Buy (`https://www.bestbuy.com/site/searchpage.jsp?st=laptop`)

- [ ] If the country selection page appears, the popup asks you to choose the United States.
- [ ] The price is the current customer price, not "Was $X" or "Save $X".
- [ ] Sold-out products without a price have an empty price.
- [ ] `product_id` is the 7-digit SKU and `product_url` opens that SKU.
- [ ] Image URLs have no `;maxHeight=…` parameters.

### eBay (`https://www.ebay.com/sch/i.html?_nkw=camera`)

- [ ] The hidden "Shop on eBay" card is not in the list (it appears under Skipped).
- [ ] Titles have no "New Listing" prefix and no "Opens in a new window or tab" suffix.
- [ ] "$12.99 to $24.99" exports as a range; listings in other currencies (for example "C $45.00") have the right currency code.
- [ ] `product_url` is `https://www.ebay.com/itm/<item number>`.
- [ ] Image files are `s-l1600` versions.
- [ ] Note: promoted listings are **not** reliably filtered on eBay (a known limitation).

### When a check fails

1. Capture the page as described in "Checking an adapter against a real page".
2. Run `npm run try-adapter` on it and compare with the page.
3. Update the selectors in `src/adapters/<platform>-adapter.js`, add the captured page (or a
   trimmed version) as a fixture with a test, and run `npm test`.
4. Update the "Tested on the live website" column in the README only after the whole
   checklist passes, and include the date.
