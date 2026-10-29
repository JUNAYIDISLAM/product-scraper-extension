/**
 * Content script. Injected on demand by the popup (activeTab + scripting)
 * into the current tab only; it is never registered for all pages.
 *
 * It only reads the page. Page data is returned as plain strings; nothing
 * from the page is ever executed.
 */
import { MSG } from '../shared/messages.js';
import { autoScroll, scanDocument } from './scan.js';
import { ErrorCodes } from '../utils/errors.js';

const LISTENER_KEY = '__multiPlatformProductExporterListener';

function onMessage(message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;

  if (message.type === MSG.PING) {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MSG.SCAN) {
    try {
      sendResponse(scanDocument(document, location.href, message.options || {}));
    } catch (error) {
      sendResponse({ ok: false, error: { code: ErrorCodes.SCAN_FAILED, message: String(error?.message || error) } });
    }
    return false;
  }

  if (message.type === MSG.AUTOSCROLL) {
    autoScroll(window, message.options || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: { code: ErrorCodes.SCAN_FAILED, message: String(error?.message || error) } }));
    return true; // keep the channel open for the async response
  }

  return false;
}

// The popup injects this file every time it opens. Replace any listener left
// by an earlier injection (or by a previous version of the extension) so that
// exactly one listener is active.
const previous = globalThis[LISTENER_KEY];
if (previous) {
  try {
    chrome.runtime.onMessage.removeListener(previous);
  } catch {
    // The previous listener belonged to an invalidated extension context.
  }
}
globalThis[LISTENER_KEY] = onMessage;
chrome.runtime.onMessage.addListener(onMessage);
