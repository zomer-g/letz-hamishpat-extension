(function (root) {
  const MSG = Object.freeze({
    TOOLBAR_TO_SW_DOWNLOAD: 'toolbar/download',
    SW_TO_TOOLBAR_PROGRESS: 'sw/progress',
    SW_TO_TOOLBAR_DONE: 'sw/done',
    SW_TO_TOOLBAR_ERROR: 'sw/error',
  });

  const DEFAULTS = Object.freeze({
    CONCURRENCY: 3,
    CONCURRENCY_MIN: 1,
    CONCURRENCY_MAX: 5,
    RETRY_ATTEMPTS: 3,
    RETRY_BACKOFF_MS: [1000, 3000, 9000],
    ZIP_NAME_PREFIX: 'נט-המשפט',
  });

  const ALLOWED_HOSTS = ['securesso.court.gov.il', 'www.court.gov.il'];
  const ALLOWED_HOST = 'securesso.court.gov.il'; // primary
  const FILENAME_SANITIZE_RE = /[\\/:*?"<>|\r\n\t]/g;

  root.CD = root.CD || {};
  root.CD.MSG = MSG;
  root.CD.DEFAULTS = DEFAULTS;
  root.CD.ALLOWED_HOST = ALLOWED_HOST;
  root.CD.ALLOWED_HOSTS = ALLOWED_HOSTS;
  root.CD.FILENAME_SANITIZE_RE = FILENAME_SANITIZE_RE;

  // Stamp the RUNNING extension version onto the page root. A page refresh does
  // NOT update extension code — only reloading the extension in chrome://extensions
  // does — so this attribute is the definitive way to confirm which build's
  // content scripts are actually live (read `document.documentElement.dataset.cdVersion`).
  try {
    if (typeof document !== 'undefined' && document.documentElement &&
        typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
      document.documentElement.setAttribute('data-cd-version', chrome.runtime.getManifest().version);
    }
  } catch (e) {}
})(typeof self !== 'undefined' ? self : globalThis);
