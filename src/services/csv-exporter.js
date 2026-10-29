/**
 * RFC 4180 CSV generation.
 *
 * - Fields containing a comma, double quote, CR or LF (or leading/trailing
 *   spaces) are wrapped in double quotes; embedded quotes are doubled.
 * - Lines end with CRLF.
 * - A UTF-8 byte order mark is prepended by default so Microsoft Excel
 *   detects the encoding and shows non-ASCII characters correctly.
 * - Spreadsheet formula injection protection: values starting with
 *   = + - @ TAB or CR are prefixed with a single quote so Excel/Sheets show
 *   them as text instead of evaluating them (OWASP "CSV injection").
 */
import { CSV_COLUMNS } from './product-normalizer.js';

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

export function escapeCsvValue(value, { protectFormulas = true } = {}) {
  let text = value == null ? '' : String(value);
  if (protectFormulas && FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (NEEDS_QUOTES.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * @param {object[]} rows
 * @param {readonly string[]} columns header names and the keys read from each row
 */
export function toCsv(rows, columns, { bom = true, eol = '\r\n', protectFormulas = true } = {}) {
  const lines = [columns.map((column) => escapeCsvValue(column, { protectFormulas: false })).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvValue(row?.[column], { protectFormulas })).join(','));
  }
  return `${bom ? '﻿' : ''}${lines.join(eol)}${eol}`;
}

/** CSV with exactly the required product columns, in the required order. */
export function productsToCsv(rows, options) {
  return toCsv(rows, CSV_COLUMNS, options);
}
