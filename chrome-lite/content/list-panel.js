// list-panel.js (LITE) — Net HaMishpat bulk document downloader.
//
// Slim build: documents only, local ZIP only (no hearings, no API, no Drive,
// no settings). Select documents in a case folder → download them all as one
// ZIP (with index.csv), split into parts for very large jobs.
//
// Per document: POST the site's __doPostBack("_ctl0:btnDocument", <arg>) →
// extract DocumentNumber from the HTML → POST GetAllImages → build a PDF from
// the page images with jsPDF. Everything runs in this tab; nothing leaves the
// browser.

(function () {
  const w = window;
  const path = location.pathname;
  if (/\/Viewer\/NGCSViewerPage\.aspx/i.test(path)) return; // not a list page

  const CD = w.CD || {};
  const adapter = CD.adapters && CD.adapters['net-court'];
  const JSZip = w.JSZip;
  const JsPDF = (w.jspdf && w.jspdf.jsPDF) || w.jsPDF;
  if (!adapter) return;
  if (!adapter.matches(location, document)) return;

  const state = { items: [], selected: new Set(), busy: false, cancel: false, els: {}, obs: null, raf: false, recipe: null };
  const MAX_PART_BYTES = 150 * 1024 * 1024;
  const MAX_PART_DOCS = 80;

  initPanel();

  function initPanel() {
    state.items = adapter.listAllItems(document);
    mountPanel();
    syncRows();
    const grid =
      document.querySelector('[id$="Grid"] .ag-root-wrapper') ||
      document.querySelector('.ag-root-wrapper') ||
      document.querySelector('[role="grid"]');
    if (grid) {
      state.obs = new MutationObserver(() => {
        if (state.raf) return;
        state.raf = true;
        requestAnimationFrame(() => { state.raf = false; state.items = adapter.listAllItems(document); syncRows(); });
      });
      state.obs.observe(grid, { childList: true, subtree: true });
    }
  }

  function mountPanel() {
    if (document.querySelector('.cd-panel')) { bindPanel(document.querySelector('.cd-panel')); return; }
    const panel = document.createElement('div');
    panel.className = 'cd-panel';
    panel.dir = 'rtl';
    panel.innerHTML =
      '<div class="cd-panel__bar">' +
        '<div class="cd-panel__title">📥 הורדת מסמכים' +
          '<span class="cd-panel__count" data-cd="total">' + state.items.length + ' מסמכים</span>' +
        '</div>' +
        '<div class="cd-panel__actions">' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--ghost" data-action="all">סמן הכל</button>' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--ghost" data-action="clear">נקה</button>' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--primary" data-action="download" disabled>' +
            'הורד ל־ZIP <span class="cd-panel__count" data-cd="count">0</span></button>' +
        '</div>' +
        '<button type="button" class="cd-panel__btn cd-panel__close" data-action="close" aria-label="הסתר">×</button>' +
      '</div>' +
      '<div class="cd-panel__status idle" data-cd="status">' +
        'סמן מסמכים ולחץ "הורד ל־ZIP". כל המסמכים הנבחרים יורדו כקובץ ZIP אחד עם אינדקס — בלי לאשר כל קובץ בנפרד.' +
      '</div>';
    const gridRoot = document.querySelector('[id$="Grid"]') || document.querySelector('[role="grid"]');
    if (gridRoot && gridRoot.parentElement) gridRoot.parentElement.insertBefore(panel, gridRoot);
    else document.body.insertBefore(panel, document.body.firstChild);
    bindPanel(panel);
  }

  function bindPanel(panel) {
    state.els.panel = panel;
    state.els.status = panel.querySelector('[data-cd="status"]');
    state.els.count = panel.querySelector('[data-cd="count"]');
    state.els.total = panel.querySelector('[data-cd="total"]');
    state.els.download = panel.querySelector('[data-action="download"]');
    if (panel.dataset.cdBound) return;
    panel.dataset.cdBound = '1';
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === 'close') { panel.remove(); if (state.obs) state.obs.disconnect(); }
      else if (a === 'all') selectAll();
      else if (a === 'clear') clearSel();
      else if (a === 'download') startDownload();
    });
  }

  function setStatus(text, kind) {
    const el = state.els.status; if (!el) return;
    el.textContent = text;
    el.classList.remove('idle', 'error'); if (kind) el.classList.add(kind);
  }
  function refreshCount() {
    if (state.els.count) state.els.count.textContent = String(state.selected.size);
    if (state.els.total) state.els.total.textContent = state.items.length + ' מסמכים';
    if (state.els.download) state.els.download.disabled = !state.busy && state.selected.size === 0;
  }

  function syncRows() {
    const rows = adapter.visibleRows(document);
    for (const r of rows) {
      if (!r.item || !r.el) continue;
      let cb = r.el.querySelector('.cd-row-cb');
      if (!cb) {
        const cell = r.el.querySelector('[role="gridcell"]'); if (!cell) continue;
        cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'cd-row-cb'; cb.title = 'בחר להורדה';
        const docId = r.item.docId;
        cb.addEventListener('click', (ev) => ev.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) state.selected.add(docId); else state.selected.delete(docId);
          refreshCount();
        });
        cell.insertBefore(cb, cell.firstChild);
      }
      const should = state.selected.has(r.item.docId);
      if (cb.checked !== should) cb.checked = should;
    }
    refreshCount();
  }

  function selectAll() {
    state.items = adapter.listAllItems(document);
    for (const it of state.items) state.selected.add(it.docId);
    syncRows();
    setStatus('נבחרו ' + state.selected.size + ' מסמכים');
  }
  function clearSel() { state.selected.clear(); syncRows(); setStatus('הבחירה נמחקה', 'idle'); }

  // ── download → ZIP (split into parts) ───────────────────────────────────
  async function startDownload() {
    if (state.busy) { state.cancel = true; setStatus('מבטל… ממתין לסיום המסמך הנוכחי.'); return; }
    if (state.selected.size === 0) return;
    if (!JSZip || !JsPDF) { setStatus('שגיאה: ספריות הקובץ לא נטענו (טען מחדש את התוסף).', 'error'); return; }
    state.busy = true; state.cancel = false; setDownloadLabel('בטל'); refreshCount();

    state.items = adapter.listAllItems(document);
    const chosen = state.items.filter((it) => state.selected.has(it.docId));
    if (!chosen.length) { finishRun(); setStatus('לא נמצאו פריטים.', 'error'); return; }

    const caseId = adapter.readCaseId(document) || 'תיק';
    const listLabel = (chosen[0] && chosen[0].docType) || 'מסמכים';
    const nameStem = caseId + ' - ' + listLabel;
    const today = new Date().toISOString().slice(0, 10);
    state.recipe = null;

    let part = null, partBytes = 0, partCount = 0, partIndex = 1, partRows = [];
    function newPart() { part = new JSZip(); partBytes = 0; partCount = 0; partRows = []; }
    async function flushPart(isLast) {
      if (!part || partCount === 0) return;
      part.file('index.csv', toCsv(partRows));
      const label = sanitize('נט-המשפט_' + nameStem + '_' + today + (isLast && partIndex === 1 ? '' : '_חלק' + partIndex), 120) + '.zip';
      const blob = await part.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      saveBlob(blob, label);
      partIndex++; part = null;
    }
    newPart();

    let ok = 0, fail = 0, sessionExpired = false;

    for (let i = 0; i < chosen.length; i++) {
      if (state.cancel) break;
      const it = chosen[i];
      const ord = i + 1;
      setStatus('מעבד ' + ord + '/' + chosen.length + ': ' + (it.title || '').slice(0, 45) + '… [' + ok + ' הוכנו]');
      let bytes = null, filename = '', status = 'נכשל', err = '';
      try {
        const dn = await fetchDocumentNumber(it);
        if (!dn) throw new Error('לא נמצא מזהה מסמך');
        const images = await fetchAllImages(dn);
        if (!images.length) throw new Error('השרת לא החזיר עמודים');
        bytes = await buildPdfBytes(images, ord, chosen.length);
        filename = pdfName(ord, it);
        status = 'הורד'; ok++;
      } catch (e) {
        err = (e && e.message) || String(e);
        if (err === 'SESSION_EXPIRED') { sessionExpired = true; break; }
        fail++;
      }
      const row = csvRow(ord, bytes ? filename : '', it, status, err);
      if (bytes) {
        part.file(filename, bytes); partBytes += bytes.byteLength; partCount++;
        partRows.push(row);
        if (partBytes >= MAX_PART_BYTES || partCount >= MAX_PART_DOCS) { setStatus('שומר חלק ' + partIndex + '…'); await flushPart(false); newPart(); }
      } else {
        partRows.push(row);
      }
    }

    try { await flushPart(true); } catch (e) {}

    if (sessionExpired) setStatus('⚠ פג תוקף הסשן אחרי ' + ok + ' מסמכים. מה שהוכן נשמר. התחבר מחדש ונסה שוב.', 'error');
    else if (state.cancel) setStatus('בוטל. ' + ok + ' מסמכים נשמרו (' + (partIndex - 1) + ' חלקים).');
    else setStatus('✓ הסתיים — ' + ok + ' מסמכים ב־' + (partIndex - 1) + ' חלקים' + (fail ? ', ' + fail + ' נכשלו (ראה index.csv)' : '') + '.', fail ? 'error' : '');
    finishRun();
  }

  function setDownloadLabel(text) { const b = state.els.download; if (b && b.childNodes[0]) b.childNodes[0].nodeValue = text + ' '; }
  function finishRun() { state.busy = false; state.cancel = false; setDownloadLabel('הורד ל־ZIP'); refreshCount(); }

  // ── postback → DocumentNumber (with recipe auto-probe) ──────────────────
  function argRecipes(item) {
    const r = item._raw || {};
    const list = [];
    if (item.postbackArg) list.push({ k: 'derived', arg: item.postbackArg });
    if (r.DocumentID != null) { list.push({ k: 'DocumentID', arg: String(r.DocumentID) }); list.push({ k: 'DocumentID&1', arg: r.DocumentID + '&1' }); }
    if (r.EntityID != null) list.push({ k: 'EntityID', arg: String(r.EntityID) });
    if (r.CaseID != null && r.DocumentID != null) { list.push({ k: 'CaseID&DocumentID', arg: r.CaseID + '&' + r.DocumentID }); list.push({ k: 'CaseID&DocumentID&1', arg: r.CaseID + '&' + r.DocumentID + '&1' }); }
    const seen = new Set(); return list.filter((x) => x.arg && !seen.has(x.arg) && seen.add(x.arg));
  }
  function buildArgByRecipe(item, key) { const f = argRecipes(item).find((x) => x.k === key); return f ? f.arg : (item.postbackArg || ''); }
  async function postDocument(item, arg) {
    const form = document.forms[0];
    const body = new URLSearchParams();
    form.querySelectorAll('input[type=hidden]').forEach((inp) => body.append(inp.name, inp.value || ''));
    body.set('__EVENTTARGET', item.postbackTarget || '_ctl0:btnDocument');
    body.set('__EVENTARGUMENT', arg);
    const res = await fetch(form.action, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (res.status === 401) throw new Error('SESSION_EXPIRED');
    const html = await res.text();
    const m = html.match(/DocumentNumber=([0-9a-f]{32})/i);
    return m ? m[1] : '';
  }
  async function fetchDocumentNumber(item) {
    if (state.recipe) return await postDocument(item, buildArgByRecipe(item, state.recipe));
    for (const c of argRecipes(item)) { const dn = await postDocument(item, c.arg); if (dn) { state.recipe = c.k; return dn; } }
    return '';
  }

  async function fetchAllImages(dn) {
    const res = await fetch('/Ngcs.Web.Secured/Viewer/NGCSViewerPage.aspx/GetAllImages', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ documentNumber: dn, startPage: 1 }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let d = (await res.json()).d;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
    if (typeof d === 'number') throw new Error('קוד שרת ' + d);
    return Array.isArray(d) ? d : [];
  }

  function toDataUrl(raw) {
    let s = String(raw || '').trim();
    if (s.charAt(0) === '<') { const m = s.match(/src\s*=\s*["']([^"']+)["']/i); if (m) s = m[1]; }
    s = s.replace(/data:image\/\.([a-z0-9]+)/i, 'data:image/$1');
    if (s.indexOf('data:') === 0) return s;
    if (s.indexOf('base64,') >= 0) return 'data:image/png;base64,' + s.split('base64,').pop();
    if (s.startsWith('/9j/')) return 'data:image/jpeg;base64,' + s;
    return 'data:image/png;base64,' + s;
  }
  function loadImg(dataUrl) {
    return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('image decode failed')); im.src = dataUrl; });
  }
  async function buildPdfBytes(images, ord, total) {
    const pdf = new JsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    for (let i = 0; i < images.length; i++) {
      setStatus('מעבד ' + ord + '/' + total + ': בונה עמוד ' + (i + 1) + '/' + images.length + '…');
      const dataUrl = toDataUrl(images[i]);
      const img = await loadImg(dataUrl);
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const scale = Math.min(pageW / iw, pageH / ih);
      const dw = iw * scale, dh = ih * scale;
      if (i > 0) pdf.addPage();
      pdf.addImage(dataUrl, dataUrl.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG', (pageW - dw) / 2, (pageH - dh) / 2, dw, dh, undefined, 'FAST');
    }
    return pdf.output('arraybuffer');
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  function sanitize(name, maxLen) { return String(name == null ? '' : name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, maxLen || 80); }
  function pdfName(ord, it) { const pad = String(ord).padStart(3, '0'); return pad + '_' + sanitize((it.docType || '') + '_' + (it.date || '') + '_' + (it.title || ''), 90) + '.pdf'; }
  function csvRow(ord, filename, it, status, err) {
    return { 'מס׳': ord, 'שם קובץ': filename, 'סוג מסמך': it.docType || '', 'תאריך': it.date || '', 'גורם': it.submittedBy || '', 'כותרת': it.title || '', 'סטטוס': status, 'שגיאה': err };
  }
  function toCsv(rows) {
    if (!rows.length) return '﻿';
    const headers = Object.keys(rows[0]);
    const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.map(esc).join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
    return '﻿' + lines.join('\r\n');
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 4000);
  }
})();
