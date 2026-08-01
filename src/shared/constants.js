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

  // The ASP.NET application root of whichever portal we're on: "/NGCS.Web.Site"
  // on the public site, "/Ngcs.Web.Secured" on the authenticated ones. The same
  // endpoints exist under both roots — but asking the public host for a secured
  // path is answered by the site's WAF with a "חסימת בקשה לא מורשית" HTML page,
  // which the downloader used to read as "the court is throttling us" and back
  // off for minutes without ever fetching a document. Always build portal URLs
  // from here (pass a URL when resolving for a page other than this one).
  function appRoot(href) {
    let path;
    try {
      path = href ? new URL(href, root.location && root.location.href).pathname
                  : (root.location ? root.location.pathname : '');
    } catch (e) { path = ''; }
    const seg = (String(path).split('/')[1] || '').trim();
    return seg ? '/' + seg : '/Ngcs.Web.Secured';
  }

  root.CD = root.CD || {};
  root.CD.appRoot = appRoot;
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
