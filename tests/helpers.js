import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

/** Loads tests/fixtures/<name> into a jsdom Document whose URL is `url`. */
export function loadFixture(name, url) {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return new JSDOM(html, { url }).window.document;
}

export function documentFromHtml(html, url) {
  return new JSDOM(html, { url }).window.document;
}

/** Minimal fetch Response stand-in for image downloader tests. */
export function fakeResponse({ status = 200, body = new Uint8Array(), contentType = 'image/jpeg', url = '', headers = {} } = {}) {
  const allHeaders = new Map(Object.entries({ 'content-type': contentType, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => allHeaders.get(name.toLowerCase()) ?? null },
    body: null,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
export const HTML_BYTES = new TextEncoder().encode('<!doctype html><html><body>Not an image</body></html>');
