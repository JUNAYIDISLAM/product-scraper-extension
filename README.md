# Multi-Platform Product Exporter

A Chrome extension (Manifest V3) that reads the products on a supported store's
**search results page** and exports them, with each product's **main image**, into
one ZIP file:

```
multi-platform-product-export-20261029-143005.zip
├── products.csv
├── export-report.json
└── images/
    ├── walmart/onn-50-class-4k-uhd-123456789/main.jpg
    ├── amazon/soundwave-wireless-headphones-B0TEST0001/main.jpg
    └── ebay/canon-eos-rebel-t7-dslr-camera-256000000001/main.webp
```

Everything runs locally in your browser. There is no backend, no account, and no data is
sent anywhere except the image requests to each store's own image server.

---

## Supported platforms and test status

| Platform   | Pages                                   | Automated fixture tests | Tested on the live website |
|------------|-----------------------------------------|-------------------------|----------------------------|
| Walmart    | `www.walmart.com/search?q=…`            | Yes                     | **No – not yet verified**  |
| Amazon.com | `www.amazon.com/s?k=…`                  | Yes                     | **No – not yet verified**  |
| Target     | `www.target.com/s?searchTerm=…`         | Yes                     | **No – not yet verified**  |
| Best Buy   | `www.bestbuy.com/site/searchpage.jsp?st=…` | Yes                  | **No – not yet verified**  |
| eBay       | `www.ebay.com/sch/i.html?_nkw=…`        | Yes                     | **No – not yet verified**  |

**Please read this before relying on the output.** Each adapter is tested against
hand-written HTML fixtures in `tests/fixtures/`. The fixtures follow each site's card markup,
but they were **not** captured from the live sites. The built extension has been run in a real
Chrome (Chrome for Testing 156) against those fixtures, including a full export and download,
but it has **not** been run against the real websites. Retailers change their markup often. Before you trust an export,
run the manual checklist in [docs/TESTING.md](docs/TESTING.md) for the platform you need. If a
site has changed, the extension reports it (for example "No product cards were found … the
layout may have changed") rather than exporting wrong data. Only the US `.com` sites are supported.

---

## Requirements (Windows)

- **Google Chrome 116 or newer.** Other Chromium browsers (such as Microsoft Edge) support the
  same APIs and may work, but they have not been tested.
- **Node.js 20 LTS or newer**, needed only to build the extension. Download the Windows
  installer from <https://nodejs.org/> and keep the default options. Check it in
  PowerShell with `node --version`.

## Install and build (Windows)

Open **PowerShell** in the project folder (in File Explorer, open the folder, then type
`powershell` in the address bar and press Enter):

```powershell
npm install
npm test
npm run build
```

- `npm install` downloads JSZip (bundled into the extension) plus the build and test tools
  (esbuild, jsdom).
- `npm test` runs the automated tests (about 125 of them).
- `npm run build` creates the loadable extension in the **`dist`** folder and validates it:
  manifest, permissions, referenced files, icons, and that every script parses.

If PowerShell says *"running scripts is disabled on this system"* when you run `npm`, use
`npm.cmd install`, `npm.cmd test` and `npm.cmd run build`, or run the commands in
**Command Prompt** (`cmd`) instead.

## Load the extension in Chrome

1. Open `chrome://extensions` in the address bar.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked** and select the **`dist`** folder (not the project folder).
4. Optional: click the puzzle-piece icon in the toolbar and pin **Multi-Platform Product Exporter**.

After you change the code, run `npm run build` again, then click the **reload** icon on the
extension's card in `chrome://extensions`, and reload the store tab.

`npm run package` also writes `release/…-extension.zip` (the built `dist` folder) and
`release/…-source.zip` (the project without `node_modules`).

## How to use

1. Open a supported site and search for products.
2. On the search results page, click the extension icon.
3. The popup shows the detected platform (top-right badge), the page URL and how many products
   were found.
4. Choose **Show up to** 10, 25, 50 or 100 products. Optionally tick **Include sponsored**.
5. If the site loads products as you scroll (Target, for example), click **Load more**. It
   scrolls this page down at most 12 screens and then rescans. It never opens other pages.
6. Tick or untick products, or use **Select all** / **Deselect all**.
7. Click **Export selected** or **Export all detected**.
8. The first time you export from a platform, Chrome asks for permission to read images from
   that store's image server (for example `m.media-amazon.com`). Click **Allow**. If you deny
   it, the export still produces `products.csv`, but the image paths are empty.
9. The ZIP is saved to your Downloads folder. You can close the popup while it works; reopen
   it to see the progress or the result.

## Output format

### `products.csv`

UTF-8 with a byte-order mark (so Excel shows accents and symbols correctly), CRLF line
endings, RFC 4180 quoting. Columns, in this order:

| Column         | Meaning |
|----------------|---------|
| `platform`     | `walmart`, `amazon`, `target`, `bestbuy` or `ebay` |
| `product_id`   | Native id: Walmart item id, Amazon ASIN, Target TCIN, Best Buy SKU, eBay item number. If a product has no id, its URL is used. |
| `product_name` | Title as shown on the card |
| `price`        | `24.97`, or `12.99 - 24.99` for a range, or empty if the card shows no price. Prices are never guessed. |
| `currency`     | ISO code, such as `USD` or `CAD`, when it can be determined; otherwise empty |
| `product_url`  | Canonical product URL on the store's own domain, without tracking parameters |
| `image_url`    | The image URL that was downloaded, or the best candidate if the download failed |
| `image`        | Path of the image **inside the ZIP**, such as `images/amazon/headphones-B0ABC123/main.jpg`, or empty if the download failed |

Text that starts with `=`, `+`, `-` or `@` gets a leading apostrophe, so spreadsheet programs
treat it as text and never run it as a formula (this is standard "CSV injection" protection).

### Images

- Only the **main** image is downloaded, one per product, in its own folder:
  `images/<platform>/<name-slug>-<product-id>/main.<ext>`.
- The extension asks for the largest available version. It removes Amazon `._AC_UY218_`
  size modifiers, Walmart `?odnHeight=` resize parameters and Best Buy `;maxHeight=`
  parameters, raises eBay `s-l225` to `s-l1600`, and requests Target `wid=1200`. If that
  version fails, it falls back to the original card image.
- The bytes are saved unchanged. The file extension (`jpg`, `png`, `webp`, `gif`, `avif`,
  `bmp`) comes from the image's real format, not from the URL.
- A failed download never stops the export. The product stays in the CSV with an empty
  `image` path, and the reason is recorded in `export-report.json` and shown in the popup.

### `export-report.json`

Export time, source page, counts, and one entry for every failed image with its reason.

A sample export made with clearly labelled fake data is in `samples/`
(`sample-products.csv`, `sample-export.zip`). Regenerate it with `npm run sample`.

---

## Permissions and why each one is needed

| Permission | Why |
|------------|-----|
| `activeTab` | Lets the extension read **only the tab you clicked the icon on**, and only after you click it. The extension has no standing access to any website. |
| `scripting` | Injects the page-reading script into that tab when you open the popup. Nothing is injected into pages automatically. |
| `downloads` | Saves the finished ZIP file to your Downloads folder. |
| `offscreen` | Builds the ZIP in a hidden extension page, so closing the popup does not cancel the export. |
| `storage` | Remembers your "Show up to" and "Include sponsored" choices (`storage.local`) and keeps export progress while the browser is open (`storage.session`). Product data is never stored permanently. |
| Optional host access to `i5.walmartimages.com`, `m.media-amazon.com`, `images-na.ssl-images-amazon.com`, `target.scene7.com`, `pisces.bbystatic.com`, `i.ebayimg.com` | Needed to download image bytes from the stores' image servers. These are **optional**: nothing is granted at install, and Chrome asks the first time you export from each platform. You can revoke them in `chrome://extensions` → Details → Site access. |

The extension does **not** request access to the store websites themselves (`activeTab`
covers that) and has no content scripts that run on every page.

## Privacy and safety

- Product data stays in your browser and in the ZIP you download. Nothing is sent to any
  third-party server, and there is no analytics or telemetry.
- Image requests go only to the HTTPS image hosts listed above. The host is checked before
  the request and again after any redirect. Requests are sent without cookies or a
  referrer, are rate-limited (one request start every 150 ms, at most 3 in parallel), time
  out after 20 seconds, are limited to 15 MB, and are retried at most once.
- Page content is treated as untrusted text. It is shown with `textContent` (never HTML) and
  never executed. Products are validated again in the background before export.
- The extension **never** bypasses CAPTCHAs, "Robot or human?" pages, logins, or other
  access controls. If such a page is detected, it tells you so and stops.
- It does not crawl. It reads only the page you have open (plus the optional, bounded scroll
  you trigger yourself) and never follows pagination.
- You are responsible for using exported data and images in line with each website's terms
  of use and with copyright law. Product images are usually copyrighted by the retailer or
  the manufacturer.

---

## Project structure

```
manifest.json                 Chrome extension manifest (MV3), copied into dist/
src/
  adapters/
    platforms.js              Platform metadata: page hosts, image hosts, currency (no DOM code)
    base-adapter.js           BaseAdapter class + shared DOM helpers (srcset, JSON-LD, fallbacks)
    walmart-adapter.js        One adapter per platform, each with its own selectors
    amazon-adapter.js
    target-adapter.js
    bestbuy-adapter.js
    ebay-adapter.js
    adapter-registry.js       List of adapters; finds the adapter for a URL
  content/
    content.js                Content script entry: answers scan/scroll messages from the popup
    scan.js                   Runs the adapter + normalizer (no chrome.* APIs, unit-testable)
  popup/
    popup.html, popup.css, popup.js   The popup UI
  background/
    service-worker.js         Starts exports, re-validates products, saves the ZIP
  offscreen/
    offscreen.html, offscreen.js      Hidden page that downloads images and builds the ZIP
  services/
    product-normalizer.js     Common product model, price parsing, dedup, validation
    image-downloader.js       Safe image fetching (allow-list, timeout, type checks, retries)
    csv-exporter.js           RFC 4180 CSV with BOM and formula protection
    zip-exporter.js           ZIP layout, folder naming, CSV/image pairing, report
  shared/messages.js          Message names and storage keys
  utils/                      filename.js, errors.js, url.js, text.js
icons/                        Extension icons (generated by scripts/generate-icons.mjs)
scripts/                      build, validate, package, sample, icons, try-adapter
tests/                        Automated tests (node:test + jsdom), HTML fixtures, e2e/ browser smoke test
samples/                      Sample CSV and ZIP
docs/                         TESTING.md, ADDING_A_PLATFORM.md
```

How the pieces talk to each other:

```
popup ──executeScript + tabs.sendMessage(MPPE_SCAN)──▶ content script (reads the page)
popup ──runtime.sendMessage(MPPE_START_EXPORT)──▶ service worker
service worker ──creates──▶ offscreen document ──fetch images, JSZip──▶ blob: URL
service worker ──chrome.downloads──▶ Downloads folder
service worker ──storage.session (exportState)──▶ popup progress bar
```

## Development commands

| Command | What it does |
|---------|--------------|
| `npm test` | Runs all automated tests (Node's built-in test runner) |
| `npm run test:e2e` | Optional: drives the built extension in Chrome for Testing (setup in docs/TESTING.md) |
| `npm run build` | Bundles `src/` with esbuild into `dist/`, copies static files, validates |
| `npm run watch` | Rebuilds the JavaScript when files change (reload the extension yourself) |
| `npm run validate` | Validates an existing `dist/` |
| `npm run package` | Builds, then writes the extension ZIP and the source ZIP to `release/` |
| `npm run sample` | Regenerates `samples/sample-products.csv` and `samples/sample-export.zip` |
| `npm run try-adapter -- <file.html> <url>` | Runs the adapter on a saved page and prints what it detects (see docs/TESTING.md) |
| `npm run icons` | Regenerates the PNG icons |

Debugging: on `chrome://extensions`, click **service worker** on the extension card for
background logs, or right-click the popup and choose **Inspect**. The content script logs to
the store tab's DevTools console.

---

## Known limitations

- **Not verified on the live sites yet** (see the table at the top). Selectors are based
  on known markup and fixtures and may need updating.
- **US `.com` sites only.** `amazon.co.uk`, `ebay.de`, `walmart.ca` and similar are reported as
  unsupported.
- **One page at a time.** Only products currently in the open page are exported; there is no
  automatic pagination. To export page 2, open it and export again.
- **Lazy-loaded cards.** Sites that render cards only near the viewport (especially Target)
  need **Load more** first; cards that are still placeholders are listed under
  "Skipped".
- **Sponsored detection is best-effort.** It works on Amazon, Walmart and Target via labels and
  ad links. eBay hides its "Sponsored" labels from page code, so promoted eBay listings may
  appear as normal listings.
- **Prices** are copied exactly as shown on the card at export time: no taxes, shipping,
  member-only prices or cart-only prices. "See price in cart" becomes an empty price.
- **Main image only.** Gallery images are not exported.
- **Walmart page data** (`__NEXT_DATA__`) is used only to fill missing fields of cards that are
  visible on the page. If it does not match (after client-side navigation), a warning is shown.
- Very large images (over 15 MB) and non-image responses are rejected.
- Chrome may close the popup while it shows the permission prompt on some systems. If that
  happens, click **Export** again: the permission is remembered and the export starts.

## Troubleshooting

| Problem | What to do |
|---------|------------|
| "This website is not supported" | Open a search results page on one of the five supported `.com` sites. |
| "Chrome does not allow extensions to read this page" | Chrome pages, the Chrome Web Store and PDF viewers cannot be read. Open the store's search page. |
| "The extension does not have access to this tab" | Click the extension icon again while the store tab is active (the `activeTab` grant is per click and ends when the tab navigates). |
| "The page script is not responding" | Reload the store tab and open the popup again (common right after reloading the extension). |
| "…is showing a verification or access-denied page" | The site wants a CAPTCHA or check. Complete it yourself in the tab, search again, then reopen the popup. The extension never bypasses it. |
| "No product cards were found … layout may have changed" | Wait for the results to finish loading and click **Rescan**. If it persists, the site's markup changed: see docs/TESTING.md ("Capturing a page") and docs/ADDING_A_PLATFORM.md. |
| Many cards under "Skipped: Card not loaded yet" | Click **Load more**. |
| Images missing; reason says "Permission … was not granted" | Export again and click **Allow**, or grant it in `chrome://extensions` → Details → Site access. |
| Images missing; reason "HTTP 403/404" | The image server refused that URL. The product is still in the CSV with its `image_url`. |
| Export seems stuck | After 2 minutes without progress the popup offers **Dismiss**. Then export again. |
| CSV shows strange characters in Excel | Open the file directly (double-click). The UTF-8 BOM makes Excel use UTF-8. With *Data → From Text/CSV*, choose "65001: Unicode (UTF-8)". |
| `npm` is not recognised | Install Node.js LTS, then close and reopen PowerShell. |

## Adding a new website

See [docs/ADDING_A_PLATFORM.md](docs/ADDING_A_PLATFORM.md). In short: add the platform to
`src/adapters/platforms.js` and its image hosts to `manifest.json`, write an adapter that
extends `BaseAdapter`, register it in `adapter-registry.js`, then add a fixture and tests.

## License

MIT (see `LICENSE`). The built extension bundles [JSZip](https://stuk.github.io/jszip/) under the MIT license.
