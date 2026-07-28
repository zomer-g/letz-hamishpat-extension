// Cross-browser shim (Firefox: chrome→browser). No-op on Chrome. Inlined
// rather than imported so it runs before anything else in this context.
if (typeof browser !== 'undefined' && browser !== globalThis.chrome) {
  try { globalThis.chrome = browser; } catch (e) {}
}

(function () {
  try {
    const m = chrome.runtime.getManifest();
    document.getElementById('ver').textContent = 'גרסה ' + (m.version || '');
  } catch (e) {}
  const p = document.getElementById('privacy');
  if (p) p.href = 'https://www.z-g.co.il/court-downloader/privacy';
  const t = document.getElementById('terms');
  if (t) t.href = 'https://www.z-g.co.il/court-downloader/terms';
  const h = document.getElementById('home');
  if (h) h.href = 'https://www.z-g.co.il/court-downloader';
  const idEl = document.getElementById('extid');
  if (idEl) { try { idEl.textContent = chrome.runtime.id; } catch (e) {} }
})();
