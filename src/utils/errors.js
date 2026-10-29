/**
 * Error codes and a typed error class used across the extension.
 *
 * Errors cross extension contexts as plain `{ code, message }` objects
 * (see `toErrorPayload`) because Error instances do not survive messaging.
 */

export const ErrorCodes = Object.freeze({
  // Page / scan errors
  NO_ACTIVE_TAB: 'NO_ACTIVE_TAB',
  UNSUPPORTED_SITE: 'UNSUPPORTED_SITE',
  RESTRICTED_PAGE: 'RESTRICTED_PAGE',
  INJECTION_FAILED: 'INJECTION_FAILED',
  CONTENT_SCRIPT_UNAVAILABLE: 'CONTENT_SCRIPT_UNAVAILABLE',
  BLOCKED_PAGE: 'BLOCKED_PAGE',
  SCAN_FAILED: 'SCAN_FAILED',
  NO_PRODUCTS: 'NO_PRODUCTS',

  // Export errors
  INVALID_REQUEST: 'INVALID_REQUEST',
  EXPORT_IN_PROGRESS: 'EXPORT_IN_PROGRESS',
  ZIP_FAILED: 'ZIP_FAILED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  OFFSCREEN_FAILED: 'OFFSCREEN_FAILED',

  // Per-image errors (recorded in the export report, never fatal)
  IMAGE_MISSING: 'IMAGE_MISSING',
  IMAGE_URL_NOT_ALLOWED: 'IMAGE_URL_NOT_ALLOWED',
  IMAGE_PERMISSION_MISSING: 'IMAGE_PERMISSION_MISSING',
  IMAGE_HTTP_ERROR: 'IMAGE_HTTP_ERROR',
  IMAGE_TIMEOUT: 'IMAGE_TIMEOUT',
  IMAGE_NETWORK_ERROR: 'IMAGE_NETWORK_ERROR',
  IMAGE_INVALID_TYPE: 'IMAGE_INVALID_TYPE',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',

  UNKNOWN: 'UNKNOWN',
});

export class ExporterError extends Error {
  /**
   * @param {string} code One of ErrorCodes.
   * @param {string} message Human-readable message, safe to show to the user.
   * @param {object} [details] Extra machine-readable data (e.g. HTTP status).
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ExporterError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Converts any thrown value into a serialisable `{ code, message }` object. */
export function toErrorPayload(error, fallbackCode = ErrorCodes.UNKNOWN) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code ? error.code : fallbackCode;
    const message = typeof error.message === 'string' && error.message ? error.message : String(error);
    return error.details !== undefined ? { code, message, details: error.details } : { code, message };
  }
  return { code: fallbackCode, message: String(error ?? 'Unknown error') };
}

/** Maps raw Chrome API error messages to explanations a user can act on. */
export function explainChromeError(message) {
  const text = String(message || '');
  if (/cannot access a chrome:\/\/|chrome-extension:\/\/|cannot be scripted|extensions gallery/i.test(text)) {
    return 'Chrome does not allow extensions to read this page.';
  }
  if (/cannot access contents of|missing host permission|must request permission/i.test(text)) {
    return 'The extension does not have access to this tab. Click the extension icon again while this tab is active.';
  }
  if (/receiving end does not exist|could not establish connection/i.test(text)) {
    return 'The page script is not responding. Reload the page and try again.';
  }
  if (/no tab with id|tab was closed/i.test(text)) {
    return 'The tab was closed or changed. Reopen the search results page and try again.';
  }
  if (/frame with id 0 was removed|frame .* was removed/i.test(text)) {
    return 'The page navigated while it was being read. Wait for it to finish loading and try again.';
  }
  return text || 'Unknown error.';
}
