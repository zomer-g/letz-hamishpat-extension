// Cross-browser namespace shim — must load FIRST in every extension context.
//
// Our code calls `chrome.*` and awaits the result. On Chrome MV3 those APIs
// already return promises. On Firefox the promise-based APIs live under
// `browser.*` while `chrome.*` is the old callback style — so we alias
// `chrome` → `browser` there and every `await chrome.*` call keeps working
// unchanged. No-op on Chrome, where `browser` is undefined.
//
// Contexts that can't rely on script order (the background event page, popup,
// options) inline these same three lines at the top of their own file instead
// of depending on this one.
(function () {
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser !== globalThis.chrome) {
    try { globalThis.chrome = globalThis.browser; } catch (e) {}
  }
})();

// Second seam: where a vendored UMD library ends up.
//
// In a Chrome content script the top-level `this` and `globalThis` ARE `window`,
// so it makes no difference which one a bundle attaches itself to. In a Firefox
// content script they are different objects — `globalThis` is the extension's
// sandbox, `window` is the page window seen through an Xray wrapper — and our
// two vendored bundles disagree:
//
//   jszip.min.js       ("undefined"!=typeof window?window:…).JSZip = …   → window
//   jspdf.umd.min.js   e((t=t||self).jspdf={})}(this, …)                 → sandbox
//
// So on Firefox `window.jspdf` is undefined and the PDF/ZIP download path bails
// out with "ספריות הקובץ לא נטענו", while ZIP-only features work. Read vendored
// globals through here instead of off `window`, and both browsers behave alike.
(function (w) {
  const CD = w.CD || (w.CD = {});
  const g = (typeof globalThis !== 'undefined') ? globalThis : w;
  CD.vendorGlobal = function (name) {
    return w[name] || g[name] || null;
  };
})(typeof window !== 'undefined' ? window : self);
