/**
 * Optional end-to-end smoke test of the BUILT extension (dist/) in Chrome for Testing.
 * It is not part of `npm test`, because it downloads a browser (about 170 MB).
 *
 * One-time setup (from the project folder):
 *   npm install --no-save puppeteer-core@24 @puppeteer/browsers@2
 *   npx @puppeteer/browsers install chrome@stable --path .e2e/browsers
 * Run:
 *   npm run build
 *   npm run test:e2e
 *
 * What it exercises for real: the popup UI, content-script injection and messaging,
 * the service worker, the offscreen document, image fetching with validation, ZIP
 * creation, chrome.downloads, export progress, closing the popup mid-export and the
 * unsupported-site path.
 *
 * Test-only differences from production (applied to a COPY of dist/ in .e2e/ext):
 *   - host permissions are pre-granted for the fixture store hosts and image hosts.
 *     Automation cannot click the toolbar icon (activeTab) or answer the permission prompt.
 *   - the popup runs in a tab, with chrome.tabs.query pointed at the store tab.
 *   - store pages are served from tests/fixtures and image requests are answered locally
 *     (some with HTTP 404 on purpose). No real website is contacted.
 * So this does NOT replace the live-site checklist in docs/TESTING.md.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

let puppeteer;
let getInstalledBrowsers;
try {
  puppeteer = (await import('puppeteer-core')).default;
  ({ getInstalledBrowsers } = await import('@puppeteer/browsers'));
} catch {
  console.error('puppeteer-core is not installed. Run:\n  npm install --no-save puppeteer-core@24 @puppeteer/browsers@2');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK = path.join(ROOT, '.e2e');
const EXT = path.join(WORK, 'ext');
const DOWNLOADS = path.join(WORK, 'downloads');
const SHOTS = path.join(WORK, 'screenshots');
const PROFILE = path.join(WORK, `profile-${Date.now()}`);
const POPUP_MAX_HEIGHT = 600; // Chrome's limit for action popups

const [installed] = await getInstalledBrowsers({ cacheDir: path.join(WORK, 'browsers') });
if (!installed) {
  console.error('Chrome for Testing is not installed. Run:\n  npx @puppeteer/browsers install chrome@stable --path .e2e/browsers');
  process.exit(2);
}
try {
  await fs.access(path.join(ROOT, 'dist', 'manifest.json'));
} catch {
  console.error('dist/ not found. Run "npm run build" first.');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// Test copy of the extension, profile and fake network
// ---------------------------------------------------------------------------

await fs.rm(EXT, { recursive: true, force: true });
await fs.cp(path.join(ROOT, 'dist'), EXT, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...manifest.optional_host_permissions, 'https://www.amazon.com/*', 'https://www.ebay.com/*', 'https://www.example.com/*'];
await fs.writeFile(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const dir of [DOWNLOADS, SHOTS]) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}
// Download folder via profile preferences. (The DevTools download override would rename files.)
await fs.mkdir(path.join(PROFILE, 'Default'), { recursive: true });
await fs.writeFile(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true },
  savefile: { default_directory: DOWNLOADS },
}));

const PNG = await fs.readFile(path.join(ROOT, 'icons', 'icon128.png'));
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const IMAGE_PREFIXES = ['https://m.media-amazon.com/', 'https://i.ebayimg.com/'];
const PAGES = {
  'https://www.amazon.com/': { fixture: 'amazon-search.html' },
  'https://www.ebay.com/': { fixture: 'ebay-search.html' },
  'https://www.example.com/': { html: '<html><body><h1>Example</h1></body></html>' },
};

function imageResponse(url) {
  if (/61img0005|IjKl0003/.test(url)) return { status: 404, body: Buffer.from('not found'), type: 'text/plain' };
  if (/61img0003/.test(url)) return { status: 200, body: PNG, type: 'image/png' };
  return { status: 200, body: JPEG, type: 'image/jpeg' };
}

const browser = await puppeteer.launch({
  executablePath: installed.executablePath,
  headless: true,
  userDataDir: PROFILE,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--disable-gpu'],
  defaultViewport: { width: 1100, height: 900 },
  protocolTimeout: 30000,
});

const logs = [];
const imageRequests = [];
// Browser-level interception covers every target, including the offscreen document.
const browserSession = await browser.target().createCDPSession();
await browserSession.send('Fetch.enable', {
  patterns: [...IMAGE_PREFIXES, ...Object.keys(PAGES)].map((prefix) => ({ urlPattern: `${prefix}*` })),
});
browserSession.on('Fetch.requestPaused', async (event) => {
  const { url } = event.request;
  try {
    let response;
    if (IMAGE_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      imageRequests.push(url);
      response = imageResponse(url);
    } else {
      const page = Object.entries(PAGES).find(([prefix]) => url.startsWith(prefix))?.[1];
      const body = page.fixture ? await fs.readFile(path.join(ROOT, 'tests', 'fixtures', page.fixture)) : Buffer.from(page.html);
      response = { status: 200, body, type: 'text/html; charset=utf-8' };
    }
    await browserSession.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: response.status,
      responseHeaders: [{ name: 'Content-Type', value: response.type }],
      body: Buffer.from(response.body).toString('base64'),
    });
  } catch (error) {
    logs.push(`interception error for ${url}: ${error.message}`);
  }
});

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
const extId = new URL(swTarget.url()).host;
(await swTarget.worker()).on('console', (m) => logs.push(`service worker console.${m.type()}: ${m.text()}`));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openStore(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  return page;
}

async function openPopup(tabUrlPattern) {
  const popup = await browser.newPage();
  await popup.setViewport({ width: 460, height: 900 });
  popup.on('pageerror', (e) => logs.push(`popup error: ${e.message}`));
  await popup.evaluateOnNewDocument((pattern) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = () => original({ url: pattern });
  }, tabUrlPattern);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
  return popup;
}

async function screenshot(page, name) {
  await page.bringToFront();
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

const popupHeight = (popup) => popup.evaluate(() => document.querySelector('.app').getBoundingClientRect().height);
const text = (page, selector) => page.$eval(selector, (e) => e.textContent);

async function waitForZips(count, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const zips = (await fs.readdir(DOWNLOADS)).filter((f) => f.endsWith('.zip'));
    if (zips.length >= count) return zips;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${count} ZIP file(s) in ${DOWNLOADS}`);
}

function parseCsv(textWithBom) {
  const source = textWithBom.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && source[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; } else cell += ch;
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

try {
  // 1. Amazon: preview, selection, export with one 404 image and one product without an image.
  const amazon = await openStore('https://www.amazon.com/s?k=wireless+headphones');
  check('Amazon fixture served', (await amazon.title()) === 'Amazon.com : wireless headphones');
  const popup = await openPopup('https://www.amazon.com/*');
  await popup.waitForSelector('#productList label.product', { timeout: 15000 });
  await screenshot(popup, '1-amazon-preview.png');
  check('Amazon: detected count', (await text(popup, '#detectedCount')) === '5 detected · showing 5 · 1 sponsored hidden', await text(popup, '#detectedCount'));
  check('Amazon: platform badge', (await text(popup, '#platformBadge')) === 'Amazon.com');
  check('Amazon: no warnings on a search page', (await popup.$$('.alert')).length === 0);
  check(`Popup fits Chrome's ${POPUP_MAX_HEIGHT}px limit (preview)`, (await popupHeight(popup)) <= POPUP_MAX_HEIGHT, `${Math.round(await popupHeight(popup))}px`);

  await popup.click('#productList li:nth-child(3) input[type=checkbox]');
  check('Amazon: selection count', (await text(popup, '#selectionCount')) === '4 of 5 selected');
  await popup.click('#exportSelectedBtn');
  await popup.waitForFunction(() => ['Export complete', 'Export failed'].includes(document.querySelector('#progressLabel')?.textContent), { timeout: 60000 });
  await screenshot(popup, '2-amazon-export-done.png');
  check('Amazon: export completes', (await text(popup, '#progressLabel')) === 'Export complete', await text(popup, '#progressMessage'));
  check('Amazon: progress counts', (await text(popup, '#progressCounts')) === 'Products 4/4 · images saved 2 · failed 2', await text(popup, '#progressCounts'));
  check(`Popup fits Chrome's ${POPUP_MAX_HEIGHT}px limit (export done)`, (await popupHeight(popup)) <= POPUP_MAX_HEIGHT, `${Math.round(await popupHeight(popup))}px`);

  const [firstZip] = await waitForZips(1);
  check('Amazon: ZIP file name', /^multi-platform-product-export-\d{8}-\d{6}\.zip$/.test(firstZip), firstZip);
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(DOWNLOADS, firstZip)));
  const csv = await zip.file('products.csv').async('string');
  check('Amazon: CSV starts with a UTF-8 BOM', csv.charCodeAt(0) === 0xfeff);
  const rows = parseCsv(csv);
  check('Amazon: selected rows in page order', rows.map((r) => r.product_id).join() === 'B0TEST0001,B0TEST0003,B0TEST0005,B0TEST0006', rows.map((r) => r.product_id).join());
  for (const row of rows.filter((r) => r.image)) {
    const bytes = await zip.file(row.image)?.async('uint8array');
    check(`Amazon: ${row.product_id} image exists in the ZIP`, Boolean(bytes?.length), row.image);
  }
  const byId = Object.fromEntries(rows.map((r) => [r.product_id, r]));
  check('Amazon: full-size image URL used', byId.B0TEST0001.image_url === 'https://m.media-amazon.com/images/I/61img0001.jpg');
  check('Amazon: PNG keeps .png', byId.B0TEST0003.image.endsWith('/main.png'), byId.B0TEST0003.image);
  check('Amazon: HTTP 404 image -> empty path', byId.B0TEST0005.image === '');
  check('Amazon: no image -> empty path', byId.B0TEST0006.image === '' && byId.B0TEST0006.image_url === '');
  check('Amazon: report lists both failures', JSON.parse(await zip.file('export-report.json').async('string')).imageFailures.length === 2);
  await popup.close();
  await amazon.close();

  // 2. eBay: export all, close the popup immediately; the export must still finish.
  const ebay = await openStore('https://www.ebay.com/sch/i.html?_nkw=camera');
  const popup2 = await openPopup('https://www.ebay.com/*');
  await popup2.waitForSelector('#productList label.product', { timeout: 15000 });
  check('eBay: sponsored-label limitation is shown', (await popup2.$$eval('.alert', (els) => els.map((e) => e.textContent))).some((t) => /promoted listings/.test(t)));
  await popup2.click('#exportAllBtn');
  await new Promise((r) => setTimeout(r, 150));
  await popup2.close();
  const secondZip = (await waitForZips(2)).find((name) => name !== firstZip);
  const rows2 = parseCsv(await (await JSZip.loadAsync(await fs.readFile(path.join(DOWNLOADS, secondZip)))).file('products.csv').async('string'));
  check('eBay: export finished after the popup was closed', rows2.length === 4, `${rows2.length} rows in ${secondZip}`);
  const ebayById = Object.fromEntries(rows2.map((r) => [r.product_id, r]));
  check('eBay: CAD price', ebayById['256000000003']?.price === '45.00' && ebayById['256000000003']?.currency === 'CAD');
  check('eBay: price range', ebayById['256000000002']?.price === '12.99 - 24.99');
  check('eBay: s-l1600 image requested', ebayById['256000000001']?.image_url === 'https://i.ebayimg.com/images/g/AbCd0001/s-l1600.webp');

  const popup3 = await openPopup('https://www.ebay.com/*');
  await popup3.waitForFunction(() => document.querySelector('#progressLabel')?.textContent === 'Export complete', { timeout: 15000 }).catch(() => {});
  check('eBay: reopened popup shows the finished export', (await text(popup3, '#progressLabel')) === 'Export complete');
  await screenshot(popup3, '3-ebay-reopened.png');
  await popup3.click('#dismissBtn');
  await popup3.waitForSelector('#progressSection[hidden]', { timeout: 5000 });
  check('eBay: Dismiss clears the result', true);
  await popup3.close();
  await ebay.close();

  // 3. Unsupported website.
  const other = await openStore('https://www.example.com/');
  const popup4 = await openPopup('https://www.example.com/*');
  await popup4.waitForSelector('.alert', { timeout: 10000 });
  check('Unsupported site: message', /not supported/.test(await text(popup4, '.alert')));
  check('Unsupported site: export buttons disabled', await popup4.$$eval('.footer button', (els) => els.every((b) => b.disabled)));
  await screenshot(popup4, '4-unsupported.png');
  await popup4.close();
  await other.close();

  check('Images were requested through the extension', imageRequests.length > 0, `${imageRequests.length} requests`);
  check('No uncaught popup errors', !logs.some((l) => l.startsWith('popup error')), logs.filter((l) => l.startsWith('popup error')).join(' | '));
} catch (error) {
  check('Smoke test run', false, error.stack);
} finally {
  if (logs.length) console.log(`\nLogs:\n${logs.join('\n')}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${SHOTS}`);
  await browser.close();
  await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  process.exit(failed ? 1 : 0);
}
