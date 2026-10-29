/**
 * Small URL helpers that never throw.
 */

/** Parses `value` (optionally relative to `base`). Returns a URL object or null. */
export function parseUrl(value, base) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return base ? new URL(text, base) : new URL(text);
  } catch {
    return null;
  }
}

/** Resolves `value` against `base` and returns an absolute http(s) URL string, or ''. */
export function toAbsoluteHttpUrl(value, base) {
  const parsed = parseUrl(value, base);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return '';
  return parsed.href;
}

/** Upgrades protocol-relative or http URLs to https. Returns '' for anything else. */
export function toHttpsUrl(value, base) {
  const parsed = parseUrl(value, base);
  if (!parsed) return '';
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  return parsed.protocol === 'https:' ? parsed.href : '';
}
