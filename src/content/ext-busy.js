// content/ext-busy.js — covers the page while a "תיק מקור" search plays out.
//
// Searching by source case can't be done in one request: the portal's own
// screen posts back once per criterion (see content/case-open.js), so the tab
// goes through two intermediate loads before the results page. Those loads
// flash the half-filled search form at the user.
//
// This script runs at document_start — BEFORE the page paints — and, if a
// source-case query is mid-flight, hides the document behind a steady
// "מחפש…" veil. The last step clears the stash, so the results page carries no
// veil and shows up immediately. Nothing here can trap the user: the veil is
// removed after a few seconds no matter what, and any failure is swallowed.
(function (w) {
  const CD = w.CD || (w.CD = {});
  const KEY = 'cd_extsearch';       // the pending query, written by case-open.js
  const VEIL_ID = 'cd-busy-veil';
  const STYLE_ID = 'cd-busy-style';
  const MAX_MS = 8000;              // hard ceiling — never leave the page covered

  function hide() {
    try {
      const veil = document.getElementById(VEIL_ID);
      if (veil) veil.remove();
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      if (document.documentElement) document.documentElement.classList.remove('cd-busy');
    } catch (e) {}
  }

  function show(text) {
    try {
      if (!document.documentElement || document.getElementById(VEIL_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      // The veil is a child of <html>, not <body> — at document_start there is
      // no body yet, and hiding the body is what stops the form from flashing.
      style.textContent =
        'html.cd-busy > body { visibility: hidden !important; }' +
        '#' + VEIL_ID + ' { position: fixed; inset: 0; z-index: 2147483647; background: #F1F5F9;' +
        ' display: flex; align-items: center; justify-content: center; direction: rtl;' +
        ' font: 600 15px/1.6 "Segoe UI", Arial, sans-serif; color: #044E66; }' +
        '#' + VEIL_ID + ' i { width: 15px; height: 15px; margin-left: 10px; border-radius: 50%;' +
        ' border: 2px solid #38AED0; border-top-color: transparent; display: inline-block;' +
        ' animation: cd-busy-spin .8s linear infinite; vertical-align: -2px; }' +
        '@keyframes cd-busy-spin { to { transform: rotate(360deg); } }';
      (document.head || document.documentElement).appendChild(style);
      const veil = document.createElement('div');
      veil.id = VEIL_ID;
      const i = document.createElement('i');
      const span = document.createElement('span');
      span.textContent = text || 'מחפש תיק מקור…';
      veil.appendChild(i);
      veil.appendChild(span);
      document.documentElement.appendChild(veil);
      document.documentElement.classList.add('cd-busy');
      setTimeout(hide, MAX_MS);
    } catch (e) {}
  }

  CD.extVeilShow = show;
  CD.extVeilHide = hide;

  // A query already in flight when this page started loading → cover it.
  // Two producers: a single quick search (content/case-open.js) and a bulk run
  // over a pasted list (content/ext-bulk.js), which writes its own progress line.
  function pendingText() {
    try {
      const bulk = sessionStorage.getItem('cd_bulk_veil');
      if (bulk) return bulk + '…';
      const q = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (q && q.num && (!q.at || Date.now() - q.at < 90000)) return 'מחפש תיק מקור ' + q.num + '…';
    } catch (e) {}
    return null;
  }
  // At document_start Firefox can run us before <html> even exists (Chrome
  // normally has it by then), and without a root element there is nothing to
  // attach the veil to. Try again on the next ticks, then once the DOM is
  // ready — worst case the veil appears a frame late instead of never.
  (function raise(tries) {
    const text = pendingText();
    if (!text) return;
    if (document.documentElement) { show(text); return; }
    if (tries > 0) { setTimeout(() => raise(tries - 1), 0); return; }
    document.addEventListener('DOMContentLoaded', () => { const t = pendingText(); if (t) show(t); });
  })(20);
})(typeof window !== 'undefined' ? window : self);
