/**
 * Popup controller: detects the platform, scans the page through the content
 * script, shows the preview, and starts exports in the background.
 *
 * All page-derived text is inserted with textContent (never innerHTML).
 */
import { detectPlatformFromUrl, imageHostPatterns, supportedPlatformNames } from '../adapters/platforms.js';
import { DEFAULT_PRODUCT_LIMIT, PRODUCT_LIMIT_OPTIONS, productKey } from '../services/product-normalizer.js';
import { EXPORT_STATUS, MSG, STORAGE_KEYS } from '../shared/messages.js';
import { ErrorCodes, explainChromeError } from '../utils/errors.js';

const $ = (id) => document.getElementById(id);
const ui = {
  platformBadge: $('platformBadge'),
  pageUrl: $('pageUrl'),
  detectedCount: $('detectedCount'),
  messages: $('messages'),
  controls: $('controls'),
  limitSelect: $('limitSelect'),
  includeSponsored: $('includeSponsored'),
  rescanBtn: $('rescanBtn'),
  scrollBtn: $('scrollBtn'),
  skippedDetails: $('skippedDetails'),
  skippedSummary: $('skippedSummary'),
  skippedList: $('skippedList'),
  previewSection: $('previewSection'),
  selectAllBox: $('selectAllBox'),
  selectionCount: $('selectionCount'),
  selectAllBtn: $('selectAllBtn'),
  deselectAllBtn: $('deselectAllBtn'),
  productList: $('productList'),
  progressSection: $('progressSection'),
  progressLabel: $('progressLabel'),
  progressPercent: $('progressPercent'),
  progressTrack: $('progressTrack'),
  progressBar: $('progressBar'),
  progressCounts: $('progressCounts'),
  progressMessage: $('progressMessage'),
  failureList: $('failureList'),
  dismissBtn: $('dismissBtn'),
  exportSelectedBtn: $('exportSelectedBtn'),
  exportAllBtn: $('exportAllBtn'),
};

const state = {
  tab: null,
  platform: null,
  scan: null,
  selected: new Set(),
  prefs: { limit: DEFAULT_PRODUCT_LIMIT, includeSponsored: false },
  busy: false,
  startingExport: false,
  exportState: null,
};

const STUCK_AFTER_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function showMessage(kind, text, group = 'scan') {
  const div = document.createElement('div');
  div.className = 'alert';
  div.dataset.kind = kind;
  div.dataset.group = group;
  div.textContent = text;
  ui.messages.append(div);
}

function clearMessages(group) {
  for (const node of [...ui.messages.children]) {
    if (!group || node.dataset.group === group) node.remove();
  }
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

async function loadPrefs() {
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.PREFS))[STORAGE_KEYS.PREFS] || {};
    if (PRODUCT_LIMIT_OPTIONS.includes(stored.limit)) state.prefs.limit = stored.limit;
    state.prefs.includeSponsored = stored.includeSponsored === true;
  } catch {
    // Defaults are fine.
  }
}

function savePrefs() {
  chrome.storage.local.set({ [STORAGE_KEYS.PREFS]: state.prefs }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Talking to the page
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/** Sends a message to the content script, injecting it first. */
async function sendToPage(message) {
  const tabId = state.tab.id;
  await injectContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function setBusy(busy, label) {
  state.busy = busy;
  ui.rescanBtn.disabled = busy;
  ui.scrollBtn.disabled = busy;
  ui.limitSelect.disabled = busy;
  ui.includeSponsored.disabled = busy;
  if (busy && label) ui.detectedCount.textContent = label;
  updateButtons();
}

async function scan() {
  if (state.busy) return;
  setBusy(true, 'Scanning page…');
  clearMessages('scan');
  try {
    const response = await sendToPage({
      type: MSG.SCAN,
      options: { limit: state.prefs.limit, includeSponsored: state.prefs.includeSponsored },
    });
    handleScanResponse(response);
  } catch (error) {
    state.scan = null;
    showMessage('error', explainChromeError(error?.message), 'scan');
    renderScan();
  } finally {
    setBusy(false);
    if (!state.scan) ui.detectedCount.textContent = '—';
  }
}

function handleScanResponse(response) {
  if (!response || typeof response !== 'object') {
    state.scan = null;
    showMessage('error', 'The page did not respond. Reload the page and try again.', 'scan');
    renderScan();
    return;
  }
  if (!response.ok) {
    state.scan = null;
    const blocked = response.error?.code === ErrorCodes.BLOCKED_PAGE;
    showMessage(blocked ? 'warning' : 'error', response.error?.message || 'The page could not be read.', 'scan');
    renderScan();
    return;
  }

  // Keep the user's selection across rescans; new products start selected.
  const previous = state.scan ? new Set(state.scan.products.map(productKey)) : new Set();
  const selected = new Set();
  for (const product of response.products) {
    const key = productKey(product);
    if (!previous.has(key) || state.selected.has(key)) selected.add(key);
  }
  state.scan = response;
  state.selected = selected;

  for (const warning of response.warnings || []) showMessage('warning', warning, 'scan');
  if (!response.products.length) {
    showMessage(
      'info',
      response.cardsFound
        ? 'Product cards were found, but none could be used. Open "Skipped" below to see why.'
        : 'No products were detected on this page. Make sure search results are visible, then click Rescan.',
      'scan',
    );
  }
  renderScan();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatPrice(product) {
  if (!product.price) return '';
  return product.currency === 'USD' || !product.currency
    ? `$${product.price.replace(' - ', ' - $')}`
    : `${product.price} ${product.currency}`;
}

function renderScan() {
  const scanResult = state.scan;
  ui.controls.hidden = !state.platform;

  if (!scanResult) {
    ui.previewSection.hidden = true;
    ui.skippedDetails.hidden = true;
    updateButtons();
    return;
  }

  const sponsoredHidden = !scanResult.includeSponsored && scanResult.sponsoredCount ? ` · ${scanResult.sponsoredCount} sponsored hidden` : '';
  ui.detectedCount.textContent =
    `${scanResult.detectedCount} detected · showing ${scanResult.products.length}` + sponsoredHidden;

  renderSkipped(scanResult);
  renderProducts(scanResult.products);
  updateButtons();
}

function renderSkipped(scanResult) {
  const entries = Object.entries(scanResult.skippedSummary || {});
  ui.skippedDetails.hidden = entries.length === 0;
  if (!entries.length) return;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  ui.skippedSummary.textContent = `Skipped ${total} card${total === 1 ? '' : 's'} — show reasons`;
  ui.skippedList.replaceChildren(
    ...entries.map(([reason, count]) => {
      const li = document.createElement('li');
      li.textContent = `${reason}: ${count}`;
      return li;
    }),
  );
}

function thumbnail(product) {
  const box = document.createElement('div');
  box.className = 'thumb';
  const placeholder = () => {
    const span = document.createElement('span');
    span.className = 'thumb-placeholder';
    span.textContent = 'No image';
    box.replaceChildren(span);
  };
  if (product.thumbnail_url) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', placeholder, { once: true });
    img.src = product.thumbnail_url;
    box.append(img);
  } else {
    placeholder();
  }
  return box;
}

function renderProducts(products) {
  ui.previewSection.hidden = false;
  if (!products.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No products to show.';
    ui.productList.replaceChildren(empty);
    return;
  }

  ui.productList.replaceChildren(
    ...products.map((product) => {
      const key = productKey(product);
      const li = document.createElement('li');
      const row = document.createElement('label');
      row.className = 'product';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(key);
      checkbox.setAttribute('aria-label', `Select ${product.product_name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(key);
        else state.selected.delete(key);
        updateButtons();
      });

      const body = document.createElement('div');
      body.className = 'product-body';
      const name = document.createElement('div');
      name.className = 'product-name';
      name.textContent = product.product_name;
      name.title = product.product_name;

      const meta = document.createElement('div');
      meta.className = 'product-meta';
      const price = document.createElement('span');
      const priceText = formatPrice(product);
      price.className = priceText ? 'price' : 'price missing';
      price.textContent = priceText || 'No price';
      const id = document.createElement('span');
      id.className = 'product-id';
      id.textContent = `ID ${product.product_id}`;
      id.title = product.product_url || product.product_id;
      meta.append(price, id);
      if (product.sponsored) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'Sponsored';
        meta.append(tag);
      }
      if (!product.image_url) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'No image';
        tag.title = (product.warnings || []).join('\n');
        meta.append(tag);
      }

      body.append(name, meta);
      row.append(checkbox, thumbnail(product), body);
      li.append(row);
      return li;
    }),
  );
}

function isExportRunning() {
  return state.startingExport || state.exportState?.status === EXPORT_STATUS.RUNNING;
}

function updateButtons() {
  const products = state.scan?.products || [];
  const selectedCount = products.filter((p) => state.selected.has(productKey(p))).length;
  const running = isExportRunning();

  ui.selectionCount.textContent = `${selectedCount} of ${products.length} selected`;
  ui.selectAllBox.checked = products.length > 0 && selectedCount === products.length;
  ui.selectAllBox.indeterminate = selectedCount > 0 && selectedCount < products.length;
  ui.selectAllBox.disabled = products.length === 0;

  ui.exportSelectedBtn.textContent = `Export selected (${selectedCount})`;
  ui.exportAllBtn.textContent = `Export all detected (${products.length})`;
  ui.exportSelectedBtn.disabled = running || state.busy || selectedCount === 0;
  ui.exportAllBtn.disabled = running || state.busy || products.length === 0;
}

function setAllSelected(selected) {
  const products = state.scan?.products || [];
  state.selected = selected ? new Set(products.map(productKey)) : new Set();
  for (const box of ui.productList.querySelectorAll('input[type="checkbox"]')) box.checked = selected;
  updateButtons();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function toTransferProduct(product) {
  return {
    platform: product.platform,
    product_id: product.product_id,
    product_name: product.product_name,
    price: product.price,
    currency: product.currency,
    product_url: product.product_url,
    image_url: product.image_url,
    image_candidates: product.image_candidates,
  };
}

async function startExport(mode) {
  const all = state.scan?.products || [];
  const products = mode === 'selected' ? all.filter((p) => state.selected.has(productKey(p))) : [...all];
  clearMessages('export');
  if (!products.length) {
    showMessage('error', mode === 'selected' ? 'Select at least one product to export.' : 'There are no products to export.', 'export');
    return;
  }

  state.startingExport = true;
  updateButtons();
  try {
    // Ask for image-host access first, while this click still counts as a user gesture.
    // Chrome only prompts the first time for each platform.
    const origins = imageHostPatterns([...new Set(products.map((p) => p.platform))]);
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins });
    } catch (error) {
      showMessage('warning', `Could not request image permission: ${error?.message || error}`, 'export');
    }
    if (!granted) {
      showMessage(
        'warning',
        'Image download permission was not granted, so the ZIP will contain products.csv without images. Click Export again and choose "Allow" to include images.',
        'export',
      );
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MSG.START_EXPORT,
        products: products.map(toTransferProduct),
        source: { platform: state.scan.platform.id, pageUrl: state.scan.pageUrl, scannedAt: state.scan.scannedAt },
      });
    } catch (error) {
      response = { ok: false, error: { message: explainChromeError(error?.message) } };
    }
    if (!response?.ok) {
      showMessage('error', response?.error?.message || 'The export could not be started.', 'export');
    } else if (response.rejected) {
      showMessage('warning', `${response.rejected} product(s) failed validation and were left out of the export.`, 'export');
    }
  } finally {
    state.startingExport = false;
    updateButtons();
  }
}

const PHASE_LABELS = {
  starting: 'Starting export…',
  images: 'Downloading images…',
  zipping: 'Creating ZIP file…',
  zipped: 'Creating ZIP file…',
  saving: 'Saving ZIP file…',
  done: 'Export complete',
  error: 'Export failed',
};

function renderExportState(exportState) {
  state.exportState = exportState || null;
  const status = exportState?.status;
  ui.progressSection.hidden = !status || status === EXPORT_STATUS.IDLE;
  updateButtons();
  if (ui.progressSection.hidden) return;

  const percent = Math.max(0, Math.min(100, Number(exportState.percent) || 0));
  ui.progressSection.dataset.status = status;
  ui.progressLabel.textContent = PHASE_LABELS[exportState.phase] || 'Exporting…';
  ui.progressPercent.textContent = `${percent}%`;
  ui.progressBar.style.width = `${percent}%`;
  ui.progressTrack.setAttribute('aria-valuenow', String(percent));

  const summary = exportState.summary;
  const saved = summary ? summary.imagesSaved : exportState.succeeded || 0;
  const failed = summary ? summary.imagesFailed : exportState.failed || 0;
  const done = summary ? summary.products : exportState.completed || 0;
  ui.progressCounts.textContent = `Products ${done}/${exportState.total || 0} · images saved ${saved} · failed ${failed}`;

  const stuck = status === EXPORT_STATUS.RUNNING && Date.now() - (exportState.updatedAt || 0) > STUCK_AFTER_MS;
  let message = '';
  if (status === EXPORT_STATUS.DONE) {
    message = `Saved ${exportState.savedAs || exportState.filename} to your Downloads folder.`;
  } else if (status === EXPORT_STATUS.ERROR) {
    message = exportState.error?.message || 'The export failed.';
  } else if (stuck) {
    message = 'This export has not reported progress for a while and may have stopped. Click Dismiss and export again.';
  } else if (status === EXPORT_STATUS.RUNNING) {
    message = 'You can close this popup; the export continues in the background.';
  }
  ui.progressMessage.textContent = message;

  const reasons = Object.entries(summary?.failureReasons || {});
  ui.failureList.replaceChildren(
    ...reasons.map(([reason, count]) => {
      const li = document.createElement('li');
      li.textContent = `${count} image${count === 1 ? '' : 's'} failed: ${reason}`;
      return li;
    }),
  );
  ui.dismissBtn.hidden = status === EXPORT_STATUS.RUNNING && !stuck;
}

async function dismissExportState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.RESET_EXPORT_STATE });
    if (response?.ok === false) showMessage('warning', response.error?.message || 'The export is still running.', 'export');
  } catch (error) {
    showMessage('error', explainChromeError(error?.message), 'export');
  }
}

async function loadExportState() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.EXPORT_STATE);
    renderExportState(stored[STORAGE_KEYS.EXPORT_STATE]);
  } catch {
    renderExportState(null);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[STORAGE_KEYS.EXPORT_STATE]) renderExportState(changes[STORAGE_KEYS.EXPORT_STATE].newValue);
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function bindEvents() {
  for (const limit of PRODUCT_LIMIT_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(limit);
    option.textContent = String(limit);
    ui.limitSelect.append(option);
  }
  ui.limitSelect.value = String(state.prefs.limit);
  ui.includeSponsored.checked = state.prefs.includeSponsored;

  ui.limitSelect.addEventListener('change', () => {
    state.prefs.limit = Number(ui.limitSelect.value);
    savePrefs();
    scan();
  });
  ui.includeSponsored.addEventListener('change', () => {
    state.prefs.includeSponsored = ui.includeSponsored.checked;
    savePrefs();
    scan();
  });
  ui.rescanBtn.addEventListener('click', () => scan());
  ui.scrollBtn.addEventListener('click', async () => {
    if (state.busy) return;
    setBusy(true, 'Scrolling page to load more products…');
    clearMessages('scan');
    try {
      await sendToPage({ type: MSG.AUTOSCROLL, options: { maxSteps: 12 } });
    } catch (error) {
      showMessage('error', explainChromeError(error?.message), 'scan');
    } finally {
      setBusy(false);
    }
    await scan();
  });
  ui.selectAllBox.addEventListener('change', () => setAllSelected(ui.selectAllBox.checked));
  ui.selectAllBtn.addEventListener('click', () => setAllSelected(true));
  ui.deselectAllBtn.addEventListener('click', () => setAllSelected(false));
  ui.exportSelectedBtn.addEventListener('click', () => startExport('selected'));
  ui.exportAllBtn.addEventListener('click', () => startExport('all'));
  ui.dismissBtn.addEventListener('click', () => dismissExportState());
}

async function init() {
  await loadPrefs();
  bindEvents();
  await loadExportState();

  try {
    state.tab = await getActiveTab();
  } catch {
    state.tab = null;
  }
  if (!state.tab?.id) {
    ui.platformBadge.textContent = 'No tab';
    ui.platformBadge.dataset.tone = 'error';
    showMessage('error', 'No active tab was found. Click the extension icon while a search results page is open.', 'scan');
    return;
  }

  const url = state.tab.url || state.tab.pendingUrl || '';
  ui.pageUrl.textContent = url || 'Unknown';
  ui.pageUrl.title = url;
  state.platform = detectPlatformFromUrl(url);

  if (!state.platform) {
    ui.platformBadge.textContent = 'Unsupported';
    ui.platformBadge.dataset.tone = 'error';
    showMessage(
      'info',
      `This website is not supported. Open a search results page on one of: ${supportedPlatformNames().join(', ')}.`,
      'scan',
    );
    renderScan();
    return;
  }

  ui.platformBadge.textContent = state.platform.name;
  ui.platformBadge.dataset.tone = 'ok';
  renderScan();
  await scan();
}

init();
