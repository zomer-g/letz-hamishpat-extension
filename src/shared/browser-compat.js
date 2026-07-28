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
