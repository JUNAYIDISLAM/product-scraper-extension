/**
 * Offscreen export worker.
 *
 * Opened by the service worker for each export. It pulls the job, downloads
 * the images, builds the ZIP and returns a blob: URL for chrome.downloads.
 * Offscreen documents can only use chrome.runtime, so all other Chrome API
 * work (permissions, downloads, storage) happens in the service worker.
 */
import { MSG } from '../shared/messages.js';
import { buildExportZip } from '../services/zip-exporter.js';
import { createImageDownloader } from '../services/image-downloader.js';
import { ErrorCodes, toErrorPayload } from '../utils/errors.js';

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn('[exporter] message failed', message.type, error);
    return undefined;
  }
}

/** Sends phase changes immediately and other progress at most every `intervalMs`. */
function createProgressReporter(jobId, intervalMs = 250) {
  let lastSent = 0;
  let lastPhase = '';
  let pending = null;
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const progress = pending;
    pending = null;
    lastSent = Date.now();
    lastPhase = progress.phase;
    send({ type: MSG.EXPORT_PROGRESS, jobId, progress });
  };
  const report = (progress) => {
    pending = progress;
    if (progress.phase !== lastPhase || Date.now() - lastSent >= intervalMs) flush();
    else if (!timer) timer = setTimeout(flush, intervalMs);
  };
  report.cancel = () => {
    clearTimeout(timer);
    pending = null;
  };
  return report;
}

async function run() {
  const job = await send({ type: MSG.OFFSCREEN_GET_JOB });
  if (!job || typeof job.id !== 'string' || !Array.isArray(job.products)) return;

  const granted = new Set(Array.isArray(job.grantedHosts) ? job.grantedHosts : []);
  const downloadImage = createImageDownloader({ isHostPermitted: (host) => granted.has(host) });
  const report = createProgressReporter(job.id);

  try {
    const { data, summary } = await buildExportZip(job.products, {
      downloadImage,
      onProgress: report,
      outputType: 'blob',
      generatedAt: new Date(job.createdAt),
      source: job.source,
    });
    report.cancel();
    // The URL stays valid until this document is closed by the service worker
    // after the download has finished.
    const blobUrl = URL.createObjectURL(data);
    await send({ type: MSG.EXPORT_READY, jobId: job.id, blobUrl, summary });
  } catch (error) {
    report.cancel();
    await send({ type: MSG.EXPORT_FAILED, jobId: job.id, error: toErrorPayload(error, ErrorCodes.ZIP_FAILED) });
  }
}

run();
