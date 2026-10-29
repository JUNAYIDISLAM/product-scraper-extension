/**
 * Text clean-up helpers shared by adapters and the normalizer.
 */

// Control characters (except tab/newline, which are collapsed later) and
// zero-width / bidi formatting characters that often appear in scraped text.
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g;

/** Removes invisible characters and collapses all whitespace runs to single spaces. */
export function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
}

/** Truncates to `maxLength` characters, adding an ellipsis when shortened. */
export function truncate(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
