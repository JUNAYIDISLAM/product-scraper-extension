/**
 * Background service worker: coordinates exports.
 *
 * 1. The popup sends MPPE_START_EXPORT with the selected products.
 * 2. Products are re-validated, the job is stored in chrome.storage.session
 *    and an offscreen document is opened. The offscreen document downloads
 *    the images and builds the ZIP, so closing the popup does not cancel it.
 * 3. The offscreen document reports progress, then hands back a blob: URL.
 * 4. chrome.downloads saves the ZIP; the offscreen document is closed when
 *    the download finishes.
 *
 * Export progress lives in chrome.storage.session (`exportState`), which the
 * popup watches. Nothing is sent to any server other than the image requests
 * to the retailers' own image hosts.
 */
import { EXPORT_STATUS, MSG, STORAGE_KEYS } from '../shared/messages.js';
import { MAX_EXPORT_PRODUCTS, sanitizeProductForExport } from '../services/product-normalizer.js';
import { getPlatform, isPlatformPageUrl } from '../adapters/platforms.js';
import { buildExportFileName } from '../utils/filename.js';
import { ErrorCodes, ExporterError, toErrorPayload } from '../utils/errors.js';
import { cleanText, truncate } from '../utils/text.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const STALE_AFTER_MS = 2 * 60 * 1000;
const session = chrome.storage.session;

// ---------------------------------------------------------------------------
// Export state (serialised updates so rapid progress messages never race)
// ---------------------------------------------------------------------------

let stateQueue = Promise.resolve();

async function readState() {
  const stored = await session.get(STORAGE_KEYS.EXPORT_STATE);
  return stored[STORAGE_KEYS.EXPORT_STATE] || { status: EXPORT_STATUS.IDLE };
}

/** Applies `update(current) -> next | null` atomically. Resolves to the stored state. */
function updateState(update) {
  const run = stateQueue.then(async () => {
    const current = await readState();
    const next = update(current);
    if (!next) return current;
    const stored = { ...next, updatedAt: Date.now() };
    await session.set({ [STORAGE_KEYS.EXPORT_STATE]: stored });
    return stored;
  });
  stateQueue = run.catch((error) => console.error('[exporter] state update failed', error));
  return run;
}

async function readJob() {
  const stored = await session.get(STORAGE_KEYS.EXPORT_JOB);
  return stored[STORAGE_KEYS.EXPORT_JOB] || null;
}

// ---------------------------------------------------------------------------
// Offscreen document
// ---------------------------------------------------------------------------

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }
  return chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : false;
}

async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch (error) {
    console.warn('[exporter] could not close offscreen document', error);
  }
}

let creatingOffscreen = null;
async function openFreshOffscreenDocument() {
  // A new document is opened for every export so it always pulls the current job.
  await closeOffscreenDocument();
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Builds the export ZIP (CSV and product images) and creates a blob URL so it can be saved with chrome.downloads.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

function isOffscreenDocument(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH);
}

async function grantedImageHosts(platformIds) {
  const granted = [];
  for (const id of platformIds) {
    for (const host of getPlatform(id)?.imageHosts || []) {
      if (await chrome.permissions.contains({ origins: [`https://${host}/*`] })) granted.push(host);
    }
  }
  return granted;
}

function sanitizeSource(source) {
  const platform = getPlatform(source?.platform);
  if (!platform) return null;
  return {
    platform: platform.id,
    pageUrl: isPlatformPageUrl(source.pageUrl, platform.id) ? String(source.pageUrl).slice(0, 2048) : '',
    scannedAt: typeof source.scannedAt === 'string' ? source.scannedAt.slice(0, 40) : '',
  };
}

async function isExportActive(state) {
  return state.status === EXPORT_STATUS.RUNNING && Date.now() - (state.updatedAt || 0) < STALE_AFTER_MS && (await hasOffscreenDocument());
}

async function startExport(message) {
  if (await isExportActive(await readState())) {
    throw new ExporterError(ErrorCodes.EXPORT_IN_PROGRESS, 'An export is already running. Wait for it to finish before starting another one.');
  }
  const input = Array.isArray(message.products) ? message.products : [];
  if (input.length > MAX_EXPORT_PRODUCTS) {
    throw new ExporterError(ErrorCodes.INVALID_REQUEST, `At most ${MAX_EXPORT_PRODUCTS} products can be exported at once.`);
  }
  const products = input.map(sanitizeProductForExport).filter(Boolean);
  if (!products.length) throw new ExporterError(ErrorCodes.NO_PRODUCTS, 'None of the selected products could be exported.');

  const platformIds = [...new Set(products.map((p) => p.platform))];
  const grantedHosts = await grantedImageHosts(platformIds);
  const createdAt = Date.now();
  const job = {
    id: crypto.randomUUID(),
    products,
    grantedHosts,
    filename: buildExportFileName(new Date(createdAt)),
    source: sanitizeSource(message.source),
    createdAt,
  };

  await session.set({ [STORAGE_KEYS.EXPORT_JOB]: job });
  await updateState(() => ({
    status: EXPORT_STATUS.RUNNING,
    phase: 'starting',
    jobId: job.id,
    filename: job.filename,
    total: products.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    percent: 0,
    rejected: input.length - products.length,
    startedAt: createdAt,
  }));

  try {
    await openFreshOffscreenDocument();
  } catch (error) {
    await failExport(job.id, { code: ErrorCodes.OFFSCREEN_FAILED, message: `Could not start the export worker: ${error?.message || error}` });
    throw new ExporterError(ErrorCodes.OFFSCREEN_FAILED, 'Could not start the export worker.');
  }
  return { ok: true, jobId: job.id, total: products.length, rejected: input.length - products.length };
}

async function getJobForOffscreen() {
  const [state, job] = await Promise.all([readState(), readJob()]);
  return state.status === EXPORT_STATUS.RUNNING && job && job.id === state.jobId ? job : null;
}

const toCount = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

function applyProgress(jobId, progress) {
  return updateState((current) => {
    if (current.jobId !== jobId || current.status !== EXPORT_STATUS.RUNNING || current.phase === 'saving') return null;
    const phase = ['images', 'zipping', 'zipped'].includes(progress?.phase) ? progress.phase : current.phase;
    return {
      ...current,
      phase,
      completed: toCount(progress?.completed),
      succeeded: toCount(progress?.succeeded),
      failed: toCount(progress?.failed),
      percent: Math.min(100, toCount(progress?.percent)),
    };
  });
}

function sanitizeSummary(summary) {
  const failureReasons = {};
  for (const [reason, count] of Object.entries(summary?.failureReasons || {}).slice(0, 10)) {
    failureReasons[truncate(cleanText(reason), 120)] = toCount(count);
  }
  return {
    products: toCount(summary?.products),
    imagesSaved: toCount(summary?.imagesSaved),
    imagesFailed: toCount(summary?.imagesFailed),
    failureReasons,
  };
}

async function failExport(jobId, error) {
  const state = await updateState((current) =>
    current.jobId === jobId && current.status === EXPORT_STATUS.RUNNING
      ? { ...current, status: EXPORT_STATUS.ERROR, phase: 'error', error: toErrorPayload(error) }
      : null,
  );
  await session.remove(STORAGE_KEYS.EXPORT_JOB);
  await closeOffscreenDocument();
  return state;
}

async function finishExport(downloadId, savedPath) {
  let finished = false;
  await updateState((current) => {
    if (current.downloadId !== downloadId || current.status !== EXPORT_STATUS.RUNNING) return null;
    finished = true;
    const savedAs = String(savedPath || '').split(/[\\/]/).pop() || current.filename;
    return { ...current, status: EXPORT_STATUS.DONE, phase: 'done', percent: 100, savedAs };
  });
  if (finished) {
    await session.remove(STORAGE_KEYS.EXPORT_JOB);
    await closeOffscreenDocument();
  }
}

async function exportReady(message) {
  const [state, job] = await Promise.all([readState(), readJob()]);
  if (!job || state.jobId !== message.jobId || job.id !== message.jobId || state.status !== EXPORT_STATUS.RUNNING) return;

  const blobPrefix = `blob:${chrome.runtime.getURL('')}`;
  if (typeof message.blobUrl !== 'string' || !message.blobUrl.startsWith(blobPrefix)) {
    await failExport(job.id, { code: ErrorCodes.ZIP_FAILED, message: 'The export worker returned an invalid file reference.' });
    return;
  }

  await updateState((current) =>
    current.jobId === job.id ? { ...current, phase: 'saving', percent: 100, summary: sanitizeSummary(message.summary) } : null,
  );

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: message.blobUrl,
      filename: job.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch (error) {
    await failExport(job.id, { code: ErrorCodes.DOWNLOAD_FAILED, message: `Chrome could not save the ZIP file: ${error?.message || error}` });
    return;
  }
  await updateState((current) => (current.jobId === job.id ? { ...current, downloadId } : null));

  // Small ZIPs can finish before downloadId was stored; check once directly.
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (item?.state === 'complete') await finishExport(downloadId, item.filename);
  else if (item?.state === 'interrupted') await downloadInterrupted(downloadId, item.error);
}

async function downloadInterrupted(downloadId, reason) {
  const state = await readState();
  if (state.downloadId !== downloadId) return;
  const message = reason === 'USER_CANCELED'
    ? 'The download was cancelled.'
    : `Chrome could not save the ZIP file (${reason || 'download interrupted'}).`;
  await failExport(state.jobId, { code: ErrorCodes.DOWNLOAD_FAILED, message });
}

async function resetExportState() {
  const state = await readState();
  if (await isExportActive(state)) return { ok: false, error: { code: ErrorCodes.EXPORT_IN_PROGRESS, message: 'An export is still running.' } };
  await session.remove([STORAGE_KEYS.EXPORT_JOB, STORAGE_KEYS.EXPORT_STATE]);
  await closeOffscreenDocument();
  return { ok: true };
}

function respond(promise, sendResponse) {
  promise.then(
    (result) => sendResponse(result ?? { ok: true }),
    (error) => sendResponse({ ok: false, error: toErrorPayload(error) }),
  );
  return true; // asynchronous response
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) return false;

  switch (message.type) {
    case MSG.START_EXPORT:
      if (!isExtensionPage(sender) || isOffscreenDocument(sender)) return false;
      return respond(startExport(message), sendResponse);
    case MSG.RESET_EXPORT_STATE:
      if (!isExtensionPage(sender)) return false;
      return respond(resetExportState(), sendResponse);
    case MSG.OFFSCREEN_GET_JOB:
      if (!isOffscreenDocument(sender)) return false;
      return respond(getJobForOffscreen(), sendResponse);
    case MSG.EXPORT_PROGRESS:
      if (!isOffscreenDocument(sender)) return false;
      return respond(applyProgress(message.jobId, message.progress).then(() => ({ ok: true })), sendResponse);
    case MSG.EXPORT_READY:
      if (!isOffscreenDocument(sender)) return false;
      return respond(exportReady(message).then(() => ({ ok: true })), sendResponse);
    case MSG.EXPORT_FAILED:
      if (!isOffscreenDocument(sender)) return false;
      return respond(failExport(message.jobId, message.error).then(() => ({ ok: true })), sendResponse);
    default:
      return false;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  const current = delta.state?.current;
  if (current === 'complete') {
    chrome.downloads.search({ id: delta.id }).then(([item]) => finishExport(delta.id, item?.filename));
  } else if (current === 'interrupted') {
    downloadInterrupted(delta.id, delta.error?.current);
  }
});
