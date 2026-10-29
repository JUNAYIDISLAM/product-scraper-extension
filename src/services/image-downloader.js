/**
 * Downloads main product images safely.
 *
 * Safety rules:
 * - Only HTTPS URLs on the platform's allow-listed image hosts are fetched,
 *   both before the request and after any redirect.
 * - Hosts the user has not granted permission for are not requested.
 * - Requests omit cookies/credentials and the referrer.
 * - Each request has a timeout and a maximum size.
 * - The HTTP status and Content-Type are validated, and the bytes must start
 *   with a known image signature. The original bytes are stored unchanged and
 *   the file extension comes from the detected format.
 * - Requests are rate limited and retried at most once for transient errors.
 */
import { isAllowedImageUrl } from '../adapters/platforms.js';
import { parseUrl } from '../utils/url.js';
import { ErrorCodes, ExporterError } from '../utils/errors.js';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MIN_INTERVAL_MS = 150;
export const DEFAULT_RETRIES = 1;

const ACCEPTED_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/gif',
  'image/webp', 'image/avif', 'image/bmp', 'image/x-ms-bmp',
]);
// Some CDNs label images generically; the byte signature check still applies.
const GENERIC_CONTENT_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

/** Detects the image format from its first bytes. Returns `{ ext, mime }` or null. */
export function detectImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) return { ext: 'png', mime: 'image/png' };
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brands = ascii(bytes, 8, Math.min(24, bytes.length - 8));
    if (/avif|avis/.test(brands)) return { ext: 'avif', mime: 'image/avif' };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
  return null;
}

/** Enforces a minimum interval between request starts (shared by all workers). */
export function createRateLimiter(minIntervalMs, sleep = defaultSleep) {
  let nextStart = 0;
  return async function waitTurn() {
    const now = Date.now();
    const startAt = Math.max(now, nextStart);
    nextStart = startAt + minIntervalMs;
    if (startAt > now) await sleep(startAt - now);
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(response, maxBytes) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ExporterError(ErrorCodes.IMAGE_TOO_LARGE, `Image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new ExporterError(ErrorCodes.IMAGE_TOO_LARGE, `Image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  return bytes;
}

/**
 * Fetches one image URL and validates it. Throws ExporterError on failure;
 * `error.details.retryable` tells the caller whether a retry could help.
 */
export async function fetchImage(url, {
  platformId,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  isHostPermitted = () => true,
} = {}) {
  if (!isAllowedImageUrl(url, platformId)) {
    throw new ExporterError(ErrorCodes.IMAGE_URL_NOT_ALLOWED, 'Image URL is not on an allowed HTTPS image host');
  }
  const host = parseUrl(url).hostname;
  if (!isHostPermitted(host)) {
    throw new ExporterError(ErrorCodes.IMAGE_PERMISSION_MISSING, `Permission to download images from ${host} was not granted`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ExporterError(ErrorCodes.IMAGE_TIMEOUT, `No response within ${Math.round(timeoutMs / 1000)} s`, { retryable: true });
      }
      throw new ExporterError(ErrorCodes.IMAGE_NETWORK_ERROR, `Network error: ${error?.message || error}`, { retryable: true });
    }

    if (response.url && response.url !== url && !isAllowedImageUrl(response.url, platformId)) {
      throw new ExporterError(ErrorCodes.IMAGE_URL_NOT_ALLOWED, 'Image request was redirected to a host that is not allowed');
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      throw new ExporterError(ErrorCodes.IMAGE_HTTP_ERROR, `HTTP ${response.status}`, {
        status: response.status,
        retryable,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      });
    }

    const contentType = (response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ACCEPTED_CONTENT_TYPES.has(contentType) && !GENERIC_CONTENT_TYPES.has(contentType)) {
      throw new ExporterError(ErrorCodes.IMAGE_INVALID_TYPE, `Unexpected content type "${contentType}"`);
    }
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new ExporterError(ErrorCodes.IMAGE_TOO_LARGE, `Image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }

    let bytes;
    try {
      bytes = await readBody(response, maxBytes);
    } catch (error) {
      if (error instanceof ExporterError) throw error;
      if (controller.signal.aborted) {
        throw new ExporterError(ErrorCodes.IMAGE_TIMEOUT, `Download did not finish within ${Math.round(timeoutMs / 1000)} s`, { retryable: true });
      }
      throw new ExporterError(ErrorCodes.IMAGE_NETWORK_ERROR, `Download interrupted: ${error?.message || error}`, { retryable: true });
    }

    const type = detectImageType(bytes);
    if (!type) throw new ExporterError(ErrorCodes.IMAGE_INVALID_TYPE, 'Response is not a JPEG, PNG, GIF, WebP, AVIF or BMP image');
    return { bytes, ext: type.ext, mime: type.mime, url, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates the `downloadImage(candidates, platformId)` function used by the
 * ZIP exporter. Candidates are tried in order (best quality first); transient
 * failures are retried once with a short back-off.
 *
 * @returns {(candidates: string[], platformId: string) => Promise<
 *   { ok: true, bytes: Uint8Array, ext: string, mime: string, url: string } |
 *   { ok: false, error: { code: string, message: string }, attempts: object[] }>}
 */
export function createImageDownloader({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  retries = DEFAULT_RETRIES,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  isHostPermitted = () => true,
  sleep = defaultSleep,
} = {}) {
  const waitTurn = createRateLimiter(minIntervalMs, sleep);

  return async function downloadImage(candidates, platformId) {
    const attempts = [];
    const list = Array.isArray(candidates) ? candidates : [];
    if (!list.length) {
      return { ok: false, error: { code: ErrorCodes.IMAGE_MISSING, message: 'No image URL was found for this product' }, attempts };
    }
    let lastError = null;
    for (const url of list) {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          // Permission / allow-list failures are decided locally; no need to wait for a request slot.
          if (isAllowedImageUrl(url, platformId) && isHostPermitted(parseUrl(url).hostname)) await waitTurn();
          const result = await fetchImage(url, { platformId, fetchImpl, timeoutMs, maxBytes, isHostPermitted });
          return { ok: true, ...result, attempts };
        } catch (error) {
          lastError = error;
          attempts.push({ url, code: error.code || ErrorCodes.UNKNOWN, message: error.message });
          const retryable = error?.details?.retryable && attempt < retries;
          if (!retryable) break;
          await sleep(Math.min(error.details.retryAfterMs ?? 800 * (attempt + 1), 5000));
        }
      }
      // A missing permission applies to every candidate on the same host set; stop early.
      if (lastError?.code === ErrorCodes.IMAGE_PERMISSION_MISSING) break;
    }
    return {
      ok: false,
      error: { code: lastError?.code || ErrorCodes.UNKNOWN, message: lastError?.message || 'Image download failed' },
      attempts,
    };
  };
}

/** Runs `worker(item, index)` over `items` with at most `limit` running at once. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
