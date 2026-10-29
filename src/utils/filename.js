/**
 * Filename and path-segment helpers for the ZIP layout.
 *
 * Every segment produced here is safe on Windows, macOS and Linux:
 * ASCII letters, digits, '.', '_' and '-' only, no leading/trailing dots,
 * no reserved Windows device names and a bounded length.
 */

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** 32-bit FNV-1a hash as 8 hex characters. Used to give URL-only products a short stable id. */
export function shortHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Lower-case, ASCII-only slug: "Samsung Galaxy S24 (256 GB)" -> "samsung-galaxy-s24-256-gb".
 * Cuts at a word boundary when longer than `maxLength`.
 */
export function slugify(value, maxLength = 40) {
  const ascii = String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= maxLength) return ascii;
  const cut = ascii.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash >= Math.floor(maxLength / 2) ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '');
}

/**
 * Makes an arbitrary string safe to use as one path segment (file or folder name).
 * Case is preserved. Returns `fallback` when nothing usable remains.
 */
export function sanitizePathSegment(value, { maxLength = 80, fallback = 'item' } = {}) {
  let segment = String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_ ]+|[.\-_ ]+$/g, '');
  if (segment.length > maxLength) segment = segment.slice(0, maxLength).replace(/[.\-_ ]+$/g, '');
  if (!segment) return fallback;
  if (WINDOWS_RESERVED_NAMES.test(segment)) segment = `_${segment}`;
  return segment;
}

/** True when `productId` is really a URL (used when a product has no native id). */
function looksLikeUrl(productId) {
  return /^https?:\/\//i.test(String(productId ?? ''));
}

/**
 * Folder name for one product: "<name-slug>-<product-id>".
 * Products whose id is a URL get an 8-character hash of the URL instead.
 */
export function buildProductFolderName(product) {
  const slug = slugify(product?.product_name, 40);
  const rawId = product?.product_id ?? '';
  const idPart = looksLikeUrl(rawId)
    ? `u${shortHash(rawId)}`
    : sanitizePathSegment(rawId, { maxLength: 40, fallback: '' });
  const joined = [slug, idPart].filter(Boolean).join('-');
  return sanitizePathSegment(joined, { maxLength: 90, fallback: `product-${shortHash(product?.product_url ?? rawId)}` });
}

/**
 * Returns `name`, or `name-2`, `name-3`, ... so that it is not already in `used`.
 * Comparison is case-insensitive because Windows and macOS file systems are.
 * The chosen name is added to `used` (which stores lower-case names).
 */
export function makeUnique(name, used) {
  let candidate = name;
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${name}-${counter}`;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** "multi-platform-product-export-20261029-143005.zip" (local time). */
export function buildExportFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `multi-platform-product-export-${stamp}.zip`;
}
