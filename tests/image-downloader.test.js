import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageDownloader, detectImageType, fetchImage, mapWithConcurrency } from '../src/services/image-downloader.js';
import { ErrorCodes } from '../src/utils/errors.js';
import { fakeResponse, HTML_BYTES, JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from './helpers.js';

const IMG = 'https://m.media-amazon.com/images/I/61img0001.jpg';
const noSleep = async () => {};

test('detectImageType recognises common formats by signature', () => {
  assert.deepEqual(detectImageType(JPEG_BYTES), { ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(detectImageType(PNG_BYTES), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(detectImageType(WEBP_BYTES), { ext: 'webp', mime: 'image/webp' });
  assert.equal(detectImageType(new TextEncoder().encode('GIF89a......')).ext, 'gif');
  assert.equal(detectImageType(new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0])).ext, 'avif');
  assert.equal(detectImageType(HTML_BYTES), null);
  assert.equal(detectImageType(new Uint8Array(3)), null);
});

test('a valid image is returned with its original bytes and detected extension', async () => {
  let requestInit;
  const fetchImpl = async (url, init) => {
    requestInit = init;
    return fakeResponse({ body: WEBP_BYTES, contentType: 'image/webp', url });
  };
  const result = await fetchImage(IMG, { platformId: 'amazon', fetchImpl });
  assert.equal(result.ext, 'webp');
  assert.deepEqual(result.bytes, WEBP_BYTES);
  assert.equal(requestInit.credentials, 'omit');
  assert.equal(requestInit.referrerPolicy, 'no-referrer');
});

test('URLs outside the platform image allow-list are never fetched', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
  };
  for (const url of ['https://evil.example/x.jpg', 'http://m.media-amazon.com/x.jpg', 'https://i.ebayimg.com/x.jpg', 'file:///C:/x.jpg']) {
    await assert.rejects(fetchImage(url, { platformId: 'amazon', fetchImpl }), { code: ErrorCodes.IMAGE_URL_NOT_ALLOWED });
  }
  assert.equal(called, false);
});

test('hosts without granted permission are not requested', async () => {
  let called = false;
  await assert.rejects(
    fetchImage(IMG, { platformId: 'amazon', fetchImpl: async () => { called = true; }, isHostPermitted: () => false }),
    { code: ErrorCodes.IMAGE_PERMISSION_MISSING },
  );
  assert.equal(called, false);
});

test('HTTP errors are reported with the status', async () => {
  const fetchImpl = async (url) => fakeResponse({ status: 404, url });
  await assert.rejects(fetchImage(IMG, { platformId: 'amazon', fetchImpl }), (error) => {
    assert.equal(error.code, ErrorCodes.IMAGE_HTTP_ERROR);
    assert.equal(error.details.status, 404);
    assert.equal(error.details.retryable, false);
    return true;
  });
});

test('wrong content types and non-image bodies are rejected', async () => {
  await assert.rejects(
    fetchImage(IMG, { platformId: 'amazon', fetchImpl: async (url) => fakeResponse({ body: HTML_BYTES, contentType: 'text/html', url }) }),
    { code: ErrorCodes.IMAGE_INVALID_TYPE },
  );
  await assert.rejects(
    fetchImage(IMG, { platformId: 'amazon', fetchImpl: async (url) => fakeResponse({ body: HTML_BYTES, contentType: 'image/jpeg', url }) }),
    { code: ErrorCodes.IMAGE_INVALID_TYPE },
  );
  // A generic content type is accepted when the bytes really are an image.
  const ok = await fetchImage(IMG, { platformId: 'amazon', fetchImpl: async (url) => fakeResponse({ body: JPEG_BYTES, contentType: 'application/octet-stream', url }) });
  assert.equal(ok.ext, 'jpg');
});

test('redirects to hosts outside the allow-list are rejected', async () => {
  const fetchImpl = async () => fakeResponse({ body: JPEG_BYTES, url: 'https://evil.example/redirected.jpg' });
  await assert.rejects(fetchImage(IMG, { platformId: 'amazon', fetchImpl }), { code: ErrorCodes.IMAGE_URL_NOT_ALLOWED });
});

test('oversized images are rejected', async () => {
  const fetchImpl = async (url) => fakeResponse({ body: JPEG_BYTES, url, headers: { 'content-length': String(50 * 1024 * 1024) } });
  await assert.rejects(fetchImage(IMG, { platformId: 'amazon', fetchImpl }), { code: ErrorCodes.IMAGE_TOO_LARGE });
  const big = new Uint8Array(2048);
  big.set(JPEG_BYTES);
  await assert.rejects(
    fetchImage(IMG, { platformId: 'amazon', fetchImpl: async (url) => fakeResponse({ body: big, url }), maxBytes: 1024 }),
    { code: ErrorCodes.IMAGE_TOO_LARGE },
  );
});

test('requests time out', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(fetchImage(IMG, { platformId: 'amazon', fetchImpl, timeoutMs: 20 }), { code: ErrorCodes.IMAGE_TIMEOUT });
});

test('network errors are reported as retryable', async () => {
  await assert.rejects(
    fetchImage(IMG, { platformId: 'amazon', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }),
    (error) => error.code === ErrorCodes.IMAGE_NETWORK_ERROR && error.details.retryable === true,
  );
});

test('the downloader falls back to the next candidate when the best one fails', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return url.endsWith('best.jpg') ? fakeResponse({ status: 404, url }) : fakeResponse({ body: JPEG_BYTES, url });
  };
  const download = createImageDownloader({ fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  const result = await download(['https://m.media-amazon.com/images/I/best.jpg', 'https://m.media-amazon.com/images/I/small.jpg'], 'amazon');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://m.media-amazon.com/images/I/small.jpg');
  assert.deepEqual(requested, ['https://m.media-amazon.com/images/I/best.jpg', 'https://m.media-amazon.com/images/I/small.jpg']);
});

test('transient errors are retried once, permanent ones are not', async () => {
  let calls = 0;
  const flaky = async (url) => {
    calls += 1;
    return calls === 1 ? fakeResponse({ status: 503, url }) : fakeResponse({ body: PNG_BYTES, contentType: 'image/png', url });
  };
  const ok = await createImageDownloader({ fetchImpl: flaky, sleep: noSleep, minIntervalMs: 0 })([IMG], 'amazon');
  assert.equal(ok.ok, true);
  assert.equal(calls, 2);

  calls = 0;
  const notFound = async (url) => {
    calls += 1;
    return fakeResponse({ status: 404, url });
  };
  const failed = await createImageDownloader({ fetchImpl: notFound, sleep: noSleep, minIntervalMs: 0 })([IMG], 'amazon');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, ErrorCodes.IMAGE_HTTP_ERROR);
  assert.equal(calls, 1);
});

test('a product without image URLs fails gracefully', async () => {
  const result = await createImageDownloader({ fetchImpl: async () => assert.fail('should not fetch') })([], 'amazon');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ErrorCodes.IMAGE_MISSING);
});

test('mapWithConcurrency preserves order and limits parallelism', async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n));
    running -= 1;
    return n * 10;
  });
  assert.deepEqual(results, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});
