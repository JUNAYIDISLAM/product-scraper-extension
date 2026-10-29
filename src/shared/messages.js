/**
 * Message types exchanged between extension contexts, and storage keys.
 *
 *   popup  --MPPE_SCAN / MPPE_AUTOSCROLL-->  content script (tabs.sendMessage)
 *   popup  --MPPE_START_EXPORT-->            background service worker
 *   offscreen --MPPE_OFFSCREEN_GET_JOB / _PROGRESS / _READY / _FAILED--> background
 *   background --chrome.storage.session (exportState)--> popup
 */
export const MSG = Object.freeze({
  SCAN: 'MPPE_SCAN',
  AUTOSCROLL: 'MPPE_AUTOSCROLL',
  PING: 'MPPE_PING',
  START_EXPORT: 'MPPE_START_EXPORT',
  RESET_EXPORT_STATE: 'MPPE_RESET_EXPORT_STATE',
  OFFSCREEN_GET_JOB: 'MPPE_OFFSCREEN_GET_JOB',
  EXPORT_PROGRESS: 'MPPE_EXPORT_PROGRESS',
  EXPORT_READY: 'MPPE_EXPORT_READY',
  EXPORT_FAILED: 'MPPE_EXPORT_FAILED',
});

export const STORAGE_KEYS = Object.freeze({
  EXPORT_STATE: 'exportState', // chrome.storage.session
  EXPORT_JOB: 'exportJob', // chrome.storage.session
  PREFS: 'prefs', // chrome.storage.local
});

export const EXPORT_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
});
