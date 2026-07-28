// list-panel.js — Net HaMishpat bulk document downloader.
//
// Runs on document-list pages under /Ngcs.Web.Secured/*. Renders a selection
// panel; on "download" it fetches every selected document AS A PDF and packs
// them all into a SINGLE ZIP (plus an index.csv) — one browser download, no
// per-file approval, no extra tabs.
//
// How a single document becomes a PDF, entirely from this tab:
//   1. POST the site's own __doPostBack("_ctl0:btnDocument", "<docId>&<flag>")
//      with the page's hidden fields. The HTML response embeds the Olive
//      viewer URL: ...NGCSViewerPage.aspx?DocumentNumber=<32-hex GUID>.
//   2. Extract that DocumentNumber and POST it to
//      NGCSViewerPage.aspx/GetAllImages — the same endpoint the Python scraper
//      uses (court_downloader.py fetch_images_via_browser). It returns the
//      page images as "<img src='data:image/.png;base64,…'>" strings.
//   3. Decode the images and lay them into a PDF with jsPDF.
//   4. zip.file(name, pdfBytes). After all docs: one zip.generateAsync download.

(function () {
  const w = window;
  const path = location.pathname;
  try { document.documentElement.setAttribute('data-cd-listpanel', '1'); } catch (e) {}

  if (/\/Viewer\/NGCSViewerPage\.aspx/i.test(path)) return; // not a list page

  const CD = w.CD || {};
  const adapter = CD.adapters && CD.adapters['net-court'];
  const JSZip = w.JSZip;
  const JsPDF = (w.jspdf && w.jspdf.jsPDF) || w.jsPDF;

  if (!adapter) return;
  if (!adapter.matches(location, document)) return;

  // If this is actually a hearings tab (מועדי דיון / יומן דיונים), the
  // hearings adapter will claim the page and the hearings-panel will mount.
  // We bail so the two panels don't fight over the same grid container.
  const hearingsAdapter = CD.adapters && CD.adapters['net-court-hearings'];
  if (hearingsAdapter && hearingsAdapter.detectMode(document)) return;

  const state = { items: [], selected: new Set(), busy: false, cancel: false, els: {}, obs: null, raf: false, settings: null, recipe: null, docFormat: 'pdf', lastClickIdx: null, wordSlowIndex: false };

  // Word download is processed IN-PAGE in batches of ≤5 (the site's limit); its
  // postback is a partial/AJAX one (no reload), so we clear + re-tick per batch.
  const WORD_JOB_KEY = 'cd_word_job'; // legacy key — cleared on load for cleanliness
  const WORD_BATCH = 5;
  // Net HaMishpat rate-limits rapid per-request bursts. The PDF (per-document)
  // path makes ~2 requests/doc, so large case files trip the limit mid-run.
  // A light delay between docs keeps us under it; retry-with-backoff recovers a
  // doc that was refused transiently.
  // Patient pace: per-document downloads (PDF and "Word with index") must stay
  // under Net HaMishpat's burst rate-limit, which otherwise blocks the session
  // mid-run for a long cooldown. ~1.5s between docs keeps a 160-doc run flowing.
  const PDF_THROTTLE_MS = 1500;
  const PDF_MAX_RETRY = 4;
  // After a pass, docs the server refused (burst cap) are retried in cleanup
  // passes — but only after a long cooldown, because the cap's block lasts
  // minutes (short in-doc retries can't outlast it).
  const CLEANUP_COOLDOWN_S = 120;
  const CLEANUP_MAX_PASSES = 8;

  // ── panel ────────────────────────────────────────────────────────────
  initListPanel();

  function initListPanel() {
    try { sessionStorage.removeItem(WORD_JOB_KEY); } catch (e) {} // drop any stale reload-era job
    state.items = adapter.listAllItems(document);
    mountPanel();
    syncRows();
    // Load destination settings (async) and reflect in the panel.
    if (w.CD && w.CD.getSettings) {
      w.CD.getSettings().then((s) => { state.settings = s; state.docFormat = (s && s.documentFormat) || 'pdf'; state.wordSlowIndex = !!(s && s.wordSlowIndex); renderDestChips(); renderFormatToggle(); });
    }
    // Live-update chips when settings change in the popup/options.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.cd_settings && w.CD && w.CD.getSettings) {
          w.CD.getSettings().then((s) => { state.settings = s; state.docFormat = (s && s.documentFormat) || 'pdf'; state.wordSlowIndex = !!(s && s.wordSlowIndex); renderDestChips(); renderFormatToggle(); });
        }
      });
    } catch (e) {}
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
    panel.setAttribute('data-cd-ver', 'batch-1');
    panel.innerHTML =
      '<div class="cd-panel__bar">' +
        '<div class="cd-panel__title">📥 הורדת מסמכים' +
          '<span class="cd-panel__count" data-cd="total">' + state.items.length + ' מסמכים</span>' +
        '</div>' +
        '<span data-cd="dests"></span>' +
        '<span data-cd="fmt"></span>' +
        '<div class="cd-panel__actions">' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--ghost" data-action="all">סימון הכל</button>' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--ghost" data-action="clear">ניקוי</button>' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--primary" data-action="download" disabled>' +
            'הורדה <span class="cd-panel__count" data-cd="count">0</span></button>' +
          '<button type="button" class="cd-panel__btn cd-panel__gear" data-action="settings" title="הגדרות">⚙</button>' +
        '</div>' +
        '<button type="button" class="cd-panel__btn cd-panel__close" data-action="close" aria-label="הסתרה">×</button>' +
      '</div>' +
      '<div class="cd-panel__status idle" data-cd="status">' +
        'ניתן לסמן מסמכים וללחוץ "הורדה". המסמכים הנבחרים יישלחו ליעדים שהוגדרו (כברירת מחדל: ZIP למחשב) — בלי לאשר כל קובץ בנפרד.' +
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
      const fb = e.target.closest('[data-fmt]');
      if (fb) { setFormat(fb.dataset.fmt); return; }
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === 'close') { panel.remove(); if (state.obs) state.obs.disconnect(); }
      else if (a === 'all') selectAll();
      else if (a === 'clear') clearSel();
      else if (a === 'download') startDownload();
      else if (a === 'settings') { try { chrome.runtime.sendMessage({ type: 'cd/openOptions' }); } catch (e) {} }
    });
    panel.addEventListener('change', (e) => {
      const c = e.target.closest('[data-wordidx]');
      if (c) setWordIndex(c.checked);
    });
    state.els.dests = panel.querySelector('[data-cd="dests"]');
    state.els.fmt = panel.querySelector('[data-cd="fmt"]');
    renderFormatToggle();
  }

  // PDF/Word format switch — shown only on screens that offer the native Word
  // download (decisions / judgments / protocols).
  function renderFormatToggle() {
    const el = state.els.fmt; if (!el) return;
    if (!adapter.supportsWordDownload(document)) { el.innerHTML = ''; return; }
    const isDoc = state.docFormat === 'doc';
    el.innerHTML = '<span class="cd-fmt">פורמט:' +
      '<button type="button" class="cd-fmt__b' + (!isDoc ? ' is-active' : '') + '" data-fmt="pdf">PDF</button>' +
      '<button type="button" class="cd-fmt__b' + (isDoc ? ' is-active' : '') + '" data-fmt="doc">Word</button>' +
      (isDoc ? '<label class="cd-fmt__idx" title="איטי יותר: מוריד מסמך-בכל-בקשה, נותן שמות לפי תאריך+תיק ומוסיף קובץ אינדקס"><input type="checkbox" data-wordidx' + (state.wordSlowIndex ? ' checked' : '') + '> עם אינדקס</label>' : '') +
      '</span>';
  }
  function setFormat(f) {
    state.docFormat = (f === 'doc') ? 'doc' : 'pdf';
    if (w.CD && w.CD.saveSettings) { try { w.CD.saveSettings({ documentFormat: state.docFormat }); } catch (e) {} }
    renderFormatToggle();
    setStatus(state.docFormat === 'doc'
      ? 'מצב Word: הקבצים יורדו כקובצי Word מקוריים מנט המשפט (עד 5 בכל אצווה).'
      : 'מצב PDF: כל מסמך נבחר ייבנה כ-PDF.', 'idle');
  }
  function setWordIndex(v) {
    state.wordSlowIndex = !!v;
    if (w.CD && w.CD.saveSettings) { try { w.CD.saveSettings({ wordSlowIndex: state.wordSlowIndex }); } catch (e) {} }
    setStatus(v
      ? 'מצב Word: עם אינדקס ושמות אינפורמטיביים (איטי — מוריד מסמך בכל פעם).'
      : 'מצב Word: מהיר (אצוות של 5, שמות נט המשפט).', 'idle');
  }

  function activeDestinations() {
    const d = (state.settings && state.settings.destinations) || { localZip: true };
    // If nothing is enabled, default to local ZIP so the button always works.
    if (!d.localZip && !d.server && !d.drive) return { localZip: true };
    return d;
  }

  function renderDestChips() {
    if (!state.els.dests) return;
    const d = activeDestinations();
    const chips = [];
    if (d.localZip) chips.push('ZIP');
    // The server (API) destination is hidden from the UI for now.
    if (d.drive) chips.push('Drive');
    state.els.dests.innerHTML = chips.map((c) => '<span class="cd-panel__dest">' + c + '</span>').join('');
  }

  function setStatus(text, kind) {
    const el = state.els.status; if (!el) return;
    el.textContent = text;
    el.classList.remove('idle', 'error'); if (kind) el.classList.add(kind);
  }
  function refreshCount() {
    if (state.els.count) state.els.count.textContent = String(state.selected.size);
    if (state.els.total) state.els.total.textContent = state.items.length + ' מסמכים';
    // Keep the button enabled while busy so it can act as a Cancel control.
    if (state.els.download) state.els.download.disabled = !state.busy && state.selected.size === 0;
  }

  function syncRows() {
    const rows = adapter.visibleRows(document);
    for (const r of rows) {
      if (!r.item) continue;
      const cell = r.cell || (r.el && r.el.querySelector('[role="gridcell"]'));
      if (!cell) continue;
      // On protocols we inject one checkbox per doc (protocol + transcript),
      // each in its own cell; hide the site's native checkbox there to avoid
      // showing two side by side.
      if (r.hideNative) {
        const nat = cell.querySelector('input[type="checkbox"]:not(.cd-row-cb)');
        if (nat) nat.style.display = 'none';
      }
      let cb = cell.querySelector('.cd-row-cb');
      if (!cb) {
        cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'cd-row-cb'; cb.title = 'לבחירה להורדה (Shift = טווח)';
        const docId = r.item.docId;
        cb.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const items = (state.items && state.items.length) ? state.items : adapter.listAllItems(document);
          const idx = items.findIndex((it) => String(it.docId) === String(docId));
          // Shift-click: (de)select the contiguous range from the last click.
          if (ev.shiftKey && state.lastClickIdx != null && idx !== -1) {
            const lo = Math.min(state.lastClickIdx, idx), hi = Math.max(state.lastClickIdx, idx);
            const want = cb.checked;
            for (let i = lo; i <= hi; i++) {
              const it = items[i]; if (!it) continue;
              if (want) state.selected.add(it.docId); else state.selected.delete(it.docId);
            }
            syncRows();
          } else {
            if (cb.checked) state.selected.add(docId); else state.selected.delete(docId);
          }
          if (idx !== -1) state.lastClickIdx = idx;
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

  // Limits for splitting large jobs into multiple ZIP parts (memory-safe).
  const MAX_PART_BYTES = 150 * 1024 * 1024; // ~150MB per ZIP part
  const MAX_PART_DOCS = 80;                  // or 80 documents, whichever first

  function progressKey(caseId) {
    return 'cd_progress_' + caseId + '_' + (adapter.readCaseId(document) ? location.pathname : '') + '_' +
      (state.items[0] ? state.items[0].docType : '');
  }
  function loadDone(key) {
    return new Promise((res) => { try { chrome.storage.local.get(key, (d) => res(new Set((d && d[key] && d[key].done) || []))); } catch (e) { res(new Set()); } });
  }
  function saveDone(key, set) {
    try { chrome.storage.local.set({ [key]: { done: Array.from(set), ts: Date.now() } }); } catch (e) {}
  }
  function clearDone(key) { try { chrome.storage.local.remove(key); } catch (e) {} }

  // ── download → stream per-doc to destinations; split ZIP into parts ──────
  async function startDownload() {
    // If already running, treat the button as Cancel.
    if (state.busy) { state.cancel = true; setStatus('מבטל… ממתין לסיום המסמך הנוכחי.'); return; }
    if (state.selected.size === 0) return;

    // Word/DOC mode (decisions / judgments / protocols): the site delivers the
    // .doc via its OWN bulk download (the response triggers a download that a
    // background fetch can't capture). So drive the site's native flow
    // SYNCHRONOUSLY inside this user gesture — tick its checkboxes + fire its
    // own postback. Works on every Word-supported screen.
    if (state.docFormat === 'doc' && adapter.supportsWordDownload(document)) {
      state.items = adapter.listAllItems(document);
      triggerNativeWord(state.items.filter((it) => state.selected.has(it.docId)));
      return;
    }

    if (!JSZip || !JsPDF) { setStatus('שגיאה: ספריות הקובץ לא נטענו (טען מחדש את התוסף).', 'error'); return; }
    // Always reload settings so the latest popup choices apply (the panel may
    // have been open before the user changed destinations).
    if (w.CD && w.CD.getSettings) { state.settings = await w.CD.getSettings(); renderDestChips(); }
    const dests = activeDestinations();
    state.busy = true; state.cancel = false; setDownloadLabel('בטל'); refreshCount();
    startKeepAlive(); // keep the F5/SAML session warm across cleanup cooldowns

    state.items = adapter.listAllItems(document);
    let chosen = state.items.filter((it) => state.selected.has(it.docId));
    if (!chosen.length) { finishRun(); setStatus('לא נמצאו פריטים.', 'error'); return; }

    const caseId = adapter.readCaseId(document) || 'תיק';
    const today = new Date().toISOString().slice(0, 10);
    state.recipe = null;

    // Resume support: skip docs already completed in a previous (interrupted) run.
    const pkey = progressKey(caseId);
    const done = await loadDone(pkey);
    const totalChosen = chosen.length;
    const already = chosen.filter((it) => done.has(it.docId)).length;
    chosen = chosen.filter((it) => !done.has(it.docId));
    if (!chosen.length) { clearDone(pkey); finishRun(); setStatus('כל ' + totalChosen + ' המסמכים שנבחרו כבר הורדו בריצה קודמת.'); return; }
    if (already) setStatus('ממשיך מריצה קודמת — דילוג על ' + already + ' שכבר הורדו.');

    // List label (the folder/category the docs came from) for naming.
    const listLabel = (chosen[0] && chosen[0].docType) || 'מסמכים';
    const nameStem = caseId + ' - ' + listLabel; // e.g. "80819-05-26 - החלטות"

    // Server/Drive config
    const serverEp = dests.server && state.settings && state.settings.server && state.settings.server.endpoint;
    const driveParent = dests.drive ? ((state.settings && state.settings.drive && state.settings.drive.folderId) || '') : '';

    // Drive: create/find a sub-folder "<caseId> - <listName>" under the
    // configured parent, and upload everything into it.
    // Upload straight into the folder the user picked — NO auto-created
    // sub-folder (that confused users: files landed in a folder they never
    // chose). Empty folderId → Drive root.
    let driveTargetId = driveParent, driveReady = !dests.drive, driveSetupErr = '';
    const driveSkipExisting = !!(state.settings && state.settings.dedupe && state.settings.dedupe.driveSkipExisting);
    let driveExistingIds = new Set();
    if (dests.drive) {
      driveReady = true;
      if (driveSkipExisting) {
        setStatus('בודק קבצים קיימים ב־Drive (מניעת כפילויות)…');
        const lr = await sendToSW({ type: 'cd/driveListDocIds', folderId: driveTargetId });
        if (lr && lr.ok && Array.isArray(lr.ids)) driveExistingIds = new Set(lr.ids.map(String));
      }
    }

    // Part accumulator for local ZIP
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
    if (dests.localZip) newPart();

    let ok = 0, sOk = 0, sFail = 0, dOk = 0, dFail = 0, dSkip = 0, sessionExpired = false;
    const allRows = []; // index of SUCCEEDED docs; still-failed docs appended at the end

    // Process ONE document: fetch → build PDF → deliver to all destinations.
    // Returns true on success. SESSION_EXPIRED sets the flag and aborts the run.
    async function processOne(it) {
      let images = null;
      for (let attempt = 0; ; attempt++) {
        try {
          const dn = await fetchDocumentNumber(it);
          if (!dn) throw new Error('לא נמצא מזהה מסמך');
          const imgs = await fetchAllImages(dn);
          if (!imgs.length) throw new Error('השרת לא החזיר עמודים');
          images = imgs; break;
        } catch (e) {
          if ((e && e.message) === 'SESSION_EXPIRED') { sessionExpired = true; return false; }
          if (state.cancel || attempt >= PDF_MAX_RETRY) return false;
          await wsleep(1000 * (attempt + 1) + 500); // 1.5s, 2.5s, 3.5s, 4.5s
        }
      }
      const ord = already + ok + 1;
      let bytes;
      try { bytes = await buildPdfBytes(images, ord, totalChosen); } catch (e) { return false; }
      ok++;
      const filename = pdfName(ord, it, caseId);
      const row = csvRow(ord, filename, it, 'הורד', '');
      allRows.push(row);
      const meta = { caseId, docType: it.docType || '', date: it.date || '', submittedBy: it.submittedBy || '', title: it.title || '', docId: it.docId };
      if (dests.localZip) {
        part.file(filename, bytes); partBytes += bytes.byteLength; partCount++;
        partRows.push(row);
        if (partBytes >= MAX_PART_BYTES || partCount >= MAX_PART_DOCS) { setStatus('שומר חלק ' + partIndex + '…'); await flushPart(false); newPart(); }
      }
      if (serverEp) { const r = await sendToSW({ type: 'cd/uploadServer', endpoint: serverEp, apiKey: (state.settings.server.apiKey || ''), filename, bytes, meta }); if (r && r.ok) sOk++; else sFail++; }
      if (dests.drive && driveReady) {
        if (driveSkipExisting && driveExistingIds.has(String(it.docId))) { dSkip++; }
        else { const r = await sendToSW({ type: 'cd/uploadDrive', folderId: driveTargetId, filename, bytes, docId: it.docId }); if (r && r.ok) { dOk++; driveExistingIds.add(String(it.docId)); } else dFail++; }
      }
      done.add(it.docId); if ((ok % 10) === 0) saveDone(pkey, done);
      return true;
    }

    // Main pass + automatic cleanup passes. The court server blocks bursts after
    // a cumulative number of per-document requests (a long cooldown follows), so
    // after each pass we wait out the cooldown and re-attempt only the docs that
    // are still missing — until none remain (or a full pass makes no progress).
    let pending = chosen.slice();
    let noProgress = 0;
    for (let pass = 1; pass <= CLEANUP_MAX_PASSES; pass++) {
      if (state.cancel || sessionExpired || !pending.length) break;
      if (pass > 1) {
        const cd = CLEANUP_COOLDOWN_S + (pass - 2) * 60; // escalate the wait: 120s, 180s, 240s…
        for (let s = cd; s > 0 && !state.cancel; s--) {
          setStatus('סבב ניקוי ' + (pass - 1) + ': ממתין ' + s + 'ש׳ לאיפוס חסימת נט המשפט (' + pending.length + ' נותרו · ' + ok + ' הוכנו)…');
          await wsleep(1000);
        }
        if (state.cancel) break;
      }
      const before = pending.length;
      const stillFailed = [];
      for (let i = 0; i < pending.length; i++) {
        if (state.cancel || sessionExpired) { for (let j = i; j < pending.length; j++) stillFailed.push(pending[j]); break; }
        const it = pending[i];
        setStatus((pass > 1 ? 'סבב ניקוי ' + (pass - 1) + ' — ' : '') + 'מעבד ' + (ok + 1) + '/' + totalChosen + ': ' + (it.title || '').slice(0, 40) + '…');
        const okItem = await processOne(it);
        if (!okItem) stillFailed.push(it);
        if (i + 1 < pending.length && !state.cancel) await wsleep(PDF_THROTTLE_MS);
      }
      pending = stillFailed;
      if (!pending.length || sessionExpired) break;
      noProgress = (pending.length >= before) ? noProgress + 1 : 0;
      if (noProgress >= 2) break; // two cooldown+passes with zero progress → give up
    }
    let fail = pending.length;
    // Record still-failed docs in the index (so the manifest is complete).
    for (const it of pending) {
      const r = csvRow(0, '', it, 'נכשל', 'חסום/נכשל אחרי ניסיונות חוזרים');
      allRows.push(r); if (dests.localZip) partRows.push(r);
    }

    // Flush remaining ZIP part(s)
    if (dests.localZip) { try { await flushPart(true); } catch (e) {} }

    // Upload a full index.csv to Drive / server too (not only the local ZIP).
    if (allRows.length) {
      const csvBytes = new TextEncoder().encode(toCsv(allRows)).buffer;
      const idxName = sanitize('index_' + nameStem + '_' + today, 120) + '.csv';
      if (dests.drive && driveReady) {
        const r = await sendToSW({ type: 'cd/uploadDrive', folderId: driveTargetId, filename: idxName, bytes: csvBytes, mimeType: 'text/csv' });
        if (r && r.ok) dOk++; else dFail++;
      }
      if (serverEp) {
        await sendToSW({ type: 'cd/uploadServer', endpoint: serverEp, apiKey: (state.settings.server.apiKey || ''), filename: idxName, bytes: csvBytes, mimeType: 'text/csv', meta: { caseId, kind: 'index' } });
      }
    }
    saveDone(pkey, done);

    const summary = [];
    if (dests.localZip) summary.push('ZIP ✓ (' + (partIndex - 1) + ' חלקים)');
    if (serverEp) summary.push('שרת ' + (sFail ? '⚠ ' + sOk + '/' + (sOk + sFail) : '✓ ' + sOk));
    else if (dests.server) summary.push('שרת ✗ (לא הוגדרה כתובת — ⚙)');
    if (dests.drive) {
      if (!driveReady) summary.push('Drive ✗ (' + (driveSetupErr || 'לא מחובר — ⚙').slice(0, 30) + ')');
      else {
        const dfn = (state.settings && state.settings.drive && state.settings.drive.folderName) || 'שורש Drive';
        summary.push('Drive→"' + dfn + '" ✓ ' + dOk + (dSkip ? ' · דילג על ' + dSkip + ' כפולים' : '') + (dFail ? ' · ' + dFail + ' נכשלו' : ''));
      }
    }

    if (sessionExpired) {
      setStatus('⚠ פג תוקף הסשן אחרי ' + ok + ' מסמכים. מה שהוכן נשמר. יש להתחבר מחדש וללחוץ "הורדה" שוב — נמשיך מהנקודה הזו. ' + summary.join(' · '), 'error');
    } else if (state.cancel) {
      setStatus('בוטל. ' + ok + ' מסמכים הוכנו ונשמרו. ' + summary.join(' · '));
    } else if (fail) {
      // Keep the progress record so a re-click of "הורדה" resumes only the
      // still-missing docs (do NOT clearDone).
      setStatus('⚠ הסתיים — ' + ok + ' מסמכים. ' + summary.join(' · ') + ' · ' + fail + ' נכשלו. לחצ/י "הורדה" שוב כדי להמשיך מהם.', 'error');
    } else {
      clearDone(pkey);
      setStatus('✓ הסתיים — ' + ok + ' מסמכים. ' + summary.join(' · '), '');
    }
    finishRun();
  }

  function wsleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ── Session keep-alive ───────────────────────────────────────────────────
  // Net HaMishpat's F5/SAML session idles out after a period of NO requests.
  // During processing the download requests keep it warm, but the cleanup
  // cooldowns (2–4 min of waiting) are idle — so ping a light authenticated
  // resource every ~3 min while a download is active to reset the idle timer.
  // (Cannot extend an absolute session lifetime — that needs re-login.)
  let _keepAliveTimer = null;
  function keepAliveUrl() {
    const el = document.querySelector('link[rel="stylesheet"][href*="court.gov.il"], script[src*="court.gov.il"], img[src*="court.gov.il"]');
    const u = el && (el.href || el.src);
    return u || location.href;
  }
  function pingKeepAlive() {
    try {
      const base = keepAliveUrl();
      const url = base + (base.indexOf('?') === -1 ? '?' : '&') + '_cdka=' + Date.now();
      fetch(url, { credentials: 'include', cache: 'no-store' }).catch(function () {});
    } catch (e) {}
  }
  function startKeepAlive() { stopKeepAlive(); pingKeepAlive(); _keepAliveTimer = setInterval(pingKeepAlive, 180000); }
  function stopKeepAlive() { if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; } }

  // ASP.NET hands a NEW __VIEWSTATE/__EVENTVALIDATION in every postback response;
  // the next postback must use them or the server rejects it. We thread them
  // across the Word batches (each postback after the first reuses stale state
  // otherwise — which silently breaks every batch but the first).
  function htmlDecode(s) {
    return String(s == null ? '' : s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  function parseViewState(html) {
    const out = {};
    ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__VIEWSTATEENCRYPTED'].forEach((k) => {
      const m = html.match(new RegExp('(?:id|name)="' + k + '"[^>]*\\bvalue="([^"]*)"')) ||
        html.match(new RegExp('\\bvalue="([^"]*)"[^>]*(?:id|name)="' + k + '"'));
      if (m) out[k] = htmlDecode(m[1]);
    });
    return out;
  }

  // Word download — pure fetch, no DOM interaction. Confirmed live: the bulk
  // "הורדת מסמכי Word" postback returns HTML whose window.open points at
  // /Ngcs.Web.Secured/DownloadDocuments.aspx?<token> (the actual Word/ZIP file).
  // So per batch of ≤5 we POST the postback (selection built straight into the
  // body by adapter.getNativeBulkRequest — no checkbox ticking, no
  // virtualization), extract the DownloadDocuments URL, fetch the file, and save
  // it. No reload, no popup, no user gesture. Works for any count via batching.

  // Pick a collision-free name inside the combined ZIP (keeps the site's names).
  function uniqueInZip(used, name) {
    let out = sanitize(name, 120) || 'doc';
    const dot = out.lastIndexOf('.');
    const base = dot > 0 ? out.slice(0, dot) : out;
    const ext = dot > 0 ? out.slice(dot) : '';
    let n = 2, cur = out;
    while (used[cur]) { cur = base + ' (' + n + ')' + ext; n++; }
    used[cur] = true;
    return cur;
  }
  // Extract the Word files from a batch's downloaded blob: if it's a ZIP, open
  // it and return each contained file; otherwise return the blob as one file.
  async function extractWordFiles(blob, ct, fallbackName) {
    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const looksZip = (u8[0] === 0x50 && u8[1] === 0x4B) || (ct || '').indexOf('zip') !== -1;
    if (looksZip && JSZip) {
      try {
        const z = await JSZip.loadAsync(buf);
        const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
        if (names.length) {
          const out = [];
          for (const n of names) out.push({ name: n.split('/').pop(), u8: await z.files[n].async('uint8array') });
          return out;
        }
      } catch (e) { /* not a readable zip → fall through */ }
    }
    return [{ name: fallbackName, u8: u8 }];
  }

  // POST the bulk-Word postback for `items`, follow the DownloadDocuments
  // handler, and return its extracted Word files. vsRef.vs threads __VIEWSTATE
  // between calls (required, or only the first call works).
  async function fetchWordBatch(items, vsRef) {
    const req = adapter.getNativeBulkRequest(items, document);
    const body = new URLSearchParams(req.body);
    if (vsRef.vs) Object.keys(vsRef.vs).forEach((k) => body.set(k, vsRef.vs[k]));
    const res = await fetch(req.url, { method: 'POST', credentials: 'include', headers: req.headers, body: body.toString() });
    if (res.status === 401) return { sessionExpired: true };
    const html = await res.text();
    // The court SSO returns a SAML logout / login.gov.il interstitial (HTTP 200,
    // not 401) once the session expires — detect it so the user gets a clear
    // "re-login" message instead of a misleading "failed".
    if (/nidp\/saml2|login\.gov\.il|does not support JavaScript, press the Continue/i.test(html)) return { sessionExpired: true };
    const nv = parseViewState(html); if (Object.keys(nv).length) vsRef.vs = Object.assign(vsRef.vs || {}, nv);
    // Success FIRST: if the site produced a DownloadDocuments URL, fetch the file.
    const m = html.match(/window\.open\(\s*['"]([^'"]*DownloadDocuments[^'"]+)['"]/i);
    if (m) {
      const dl = await fetch(new URL(m[1].replace(/&amp;/g, '&'), location.href).href, { credentials: 'include' });
      if (!dl.ok) return { fail: true };
      const blob = await dl.blob();
      if (!blob || blob.size < 64) return { fail: true };
      const ct = (dl.headers.get('content-type') || '').toLowerCase();
      const fb = filenameFromCD(dl.headers.get('content-disposition'), 'word' + guessExt(ct));
      return { files: await extractWordFiles(blob, ct, fb) };
    }
    // No download URL → the site refused the selection because a document isn't
    // exportable to Word. On פרוטוקולים the page text carries
    // "המסמכים הבאים אינם ניתנים להורדה"; on החלטות/פסקי דין that warning is a
    // modal whose TEXT is injected client-side (so it's absent from the HTML) —
    // but its acknowledge button `btnDownloadWordDocs2` IS rendered in the
    // response. Either signal means "blocked". (Checked AFTER DownloadDocuments,
    // so a successful response that also contains btn2 is never mislabeled.)
    if (html.indexOf('אינם ניתנים להורדה') !== -1 || /btnDownloadWordDocs2/.test(html)) return { blocked: true };
    return { fail: true };
  }
  function bufOf(u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }

  let wordRunning = false;
  async function triggerNativeWord(chosen) {
    if (wordRunning) return;
    if (!chosen || !chosen.length) { setStatus('לא נבחרו מסמכים.', 'error'); return; }
    wordRunning = true;
    state.wordCancel = false;
    startKeepAlive(); // keep the session warm across cleanup cooldowns
    if (w.CD && w.CD.getSettings) { try { state.settings = await w.CD.getSettings(); } catch (e) {} }
    const slow = !!(state.settings && state.settings.wordSlowIndex); // one-at-a-time → informative names + index
    const dests = activeDestinations();
    const caseId = adapter.readCaseId(document) || 'תיק';
    const listLabel = (chosen[0] && chosen[0].docType) || 'מסמכים';
    const nameStem = caseId + ' - ' + listLabel; // folder/zip stem — NO date (stable across downloads)
    const total = chosen.length;

    const serverEp = dests.server && state.settings && state.settings.server && state.settings.server.endpoint;
    // Upload straight into the chosen folder — no auto sub-folder. Empty → root.
    let driveTargetId = (state.settings && state.settings.drive && state.settings.drive.folderId) || '';
    let driveReady = false, driveExisting = new Set();
    if (dests.drive) {
      driveReady = true;
      // Skip docs already in the Drive folder (slow mode only — that's where a
      // per-file docId exists). Lets re-downloads add without duplicating.
      if (slow && state.settings.dedupe && state.settings.dedupe.driveSkipExisting) {
        showWordMask('בודק קבצים קיימים ב־Drive…', 0);
        const lr = await sendToSW({ type: 'cd/driveListDocIds', folderId: driveTargetId });
        if (lr && lr.ok && Array.isArray(lr.ids)) driveExisting = new Set(lr.ids.map(String));
      }
    }
    const saveToDisk = dests.localZip || (!serverEp && !driveReady);
    const master = (saveToDisk && JSZip) ? new JSZip() : null; // combined ZIP for disk
    const usedZip = {};
    const indexRows = [];

    // Deliver one Word file to every enabled destination (disk→ZIP, Drive/server
    // → individual files).
    async function deliver(u8, name, item, skipDrive) {
      const nm = sanitize(name, 120) || 'doc';
      if (master) master.file(uniqueInZip(usedZip, nm), u8);
      else if (saveToDisk) saveBlob(new Blob([u8]), nm);
      // skipDrive: this doc is already in the Drive folder (dedup) — still deliver
      // it to disk/server, just don't re-upload it to Drive.
      if (driveReady && !skipDrive) await sendToSW({ type: 'cd/uploadDrive', folderId: driveTargetId, filename: nm, bytes: bufOf(u8), mimeType: 'application/octet-stream', docId: item ? item.docId : undefined });
      if (serverEp) await sendToSW({ type: 'cd/uploadServer', endpoint: serverEp, apiKey: (state.settings.server.apiKey || ''), filename: nm, bytes: bufOf(u8), mimeType: 'application/octet-stream', meta: { caseId, kind: 'word', docType: listLabel } });
      if (item) indexRows.push(csvRow(indexRows.length + 1, nm, item, 'הורד', ''));
    }

    let ok = 0, blocked = 0, fail = 0, skipped = 0, sessionExpired = false;
    const vsRef = { vs: null };
    showWordMask('מוריד Word — 0/' + total + '…', 0);
    try {
      if (slow) {
        // Process ONE doc (one-at-a-time → informative name + index entry).
        // Returns true when handled (downloaded / already-in-Drive / genuinely
        // blocked); false when the server refused it (retry in a cleanup pass).
        async function processOneWord(item) {
          const inDrive = driveReady && driveExisting.has(String(item.docId));
          if (inDrive && !saveToDisk && !serverEp) { skipped++; return true; }
          let r = null;
          for (let attempt = 0; ; attempt++) {
            r = await fetchWordBatch([item], vsRef);
            if (r.sessionExpired || r.blocked || r.files) break;
            if (state.wordCancel || attempt >= PDF_MAX_RETRY) break;
            await wsleep(1000 * (attempt + 1) + 500);
          }
          if (r.sessionExpired) { sessionExpired = true; return false; }
          if (r.blocked) { blocked++; return true; } // genuinely unavailable — don't retry
          if (!r.files) return false;                // refused (rate limit) — retry later
          let k = 0;
          for (const f of r.files) {
            const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.doc'])[0];
            const nm = infoStem(item, caseId) + (r.files.length > 1 ? ' (' + (++k) + ')' : '') + ext;
            await deliver(f.u8, nm, item, inDrive);
          }
          ok++;
          return true;
        }
        // Main pass + automatic cleanup passes (long cooldown between them so the
        // server's burst block resets), until every doc is downloaded.
        let pending = chosen.slice();
        let noProgress = 0;
        for (let pass = 1; pass <= CLEANUP_MAX_PASSES; pass++) {
          if (state.wordCancel || sessionExpired || !pending.length) break;
          if (pass > 1) {
            const cd = CLEANUP_COOLDOWN_S + (pass - 2) * 60; // escalate: 120s, 180s, 240s…
            for (let s = cd; s > 0 && !state.wordCancel; s--) {
              showWordMask('סבב ניקוי ' + (pass - 1) + ': ממתין ' + s + 'ש׳ לאיפוס חסימת נט המשפט (' + pending.length + ' נותרו · ' + ok + ' הוכנו)…', ok / total);
              await wsleep(1000);
            }
            if (state.wordCancel) break;
          }
          const before = pending.length;
          const stillFailed = [];
          for (let i = 0; i < pending.length; i++) {
            if (state.wordCancel || sessionExpired) { for (let j = i; j < pending.length; j++) stillFailed.push(pending[j]); break; }
            const item = pending[i];
            showWordMask((pass > 1 ? 'סבב ניקוי ' + (pass - 1) + ' — ' : '') + 'מוריד Word (עם אינדקס) — ' + (ok + 1) + '/' + total + '…', ok / total);
            const okItem = await processOneWord(item);
            if (!okItem) stillFailed.push(item);
            if (i + 1 < pending.length && !state.wordCancel) await wsleep(PDF_THROTTLE_MS);
          }
          pending = stillFailed;
          if (!pending.length || sessionExpired) break;
          noProgress = (pending.length >= before) ? noProgress + 1 : 0;
          if (noProgress >= 2) break;
        }
        fail = pending.length;
      } else {
        const totalBatches = Math.ceil(total / WORD_BATCH);
        let batchNum = 0;
        for (let i = 0; i < chosen.length; i += WORD_BATCH) {
          if (state.wordCancel) break;
          batchNum++;
          const batch = chosen.slice(i, i + WORD_BATCH);
          showWordMask('מוריד Word — אצווה ' + batchNum + '/' + totalBatches + ' (' + ok + '/' + total + ')…', ok / total);
          const r = await fetchWordBatch(batch, vsRef);
          if (r.sessionExpired) { sessionExpired = true; break; }
          if (r.files) {
            for (const f of r.files) await deliver(f.u8, f.name, null);
            ok += batch.length;
            await wsleep(300);
            continue;
          }
          // The batch failed AS A WHOLE — almost always because ONE document in
          // it isn't available for Word (נט המשפט returns "המסמכים הבאים אינם
          // ניתנים להורדה" and refuses the entire selection). A single bad doc
          // must not sink the 4 good ones, so fall back to retrying each item
          // alone: good docs download, the offending doc is counted+skipped.
          if (batch.length === 1) { if (r.blocked) blocked++; else fail++; await wsleep(250); continue; }
          showWordMask('מדלג על מסמך חסום — מוריד את השאר בנפרד (' + ok + '/' + total + ')…', ok / total);
          for (const item of batch) {
            if (state.wordCancel) break;
            const rr = await fetchWordBatch([item], vsRef);
            if (rr.sessionExpired) { sessionExpired = true; break; }
            if (rr.files) { for (const f of rr.files) await deliver(f.u8, f.name, null); ok++; }
            else if (rr.blocked) blocked++;
            else fail++;
            await wsleep(250);
          }
          if (sessionExpired) break;
          await wsleep(300);
        }
      }

      // index.csv (slow mode) → into the combined ZIP and to Drive/server.
      if (slow && indexRows.length) {
        const csv = toCsv(indexRows);
        if (master) master.file('index.csv', csv);
        const csvBytes = new TextEncoder().encode(csv).buffer;
        const idxName = 'index_' + sanitize(nameStem, 100) + '.csv';
        if (driveReady) await sendToSW({ type: 'cd/uploadDrive', folderId: driveTargetId, filename: idxName, bytes: csvBytes, mimeType: 'text/csv' });
        if (serverEp) await sendToSW({ type: 'cd/uploadServer', endpoint: serverEp, apiKey: (state.settings.server.apiKey || ''), filename: idxName, bytes: csvBytes, mimeType: 'text/csv', meta: { caseId, kind: 'index' } });
      }
      // Save the combined ZIP to disk once.
      if (master && ok && !state.wordCancel) {
        showWordMask('אורז ל-ZIP אחד…', 1);
        const zipName = sanitize('נט-המשפט_' + nameStem + '_Word', 110) + '.zip';
        saveBlob(await master.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }), zipName);
      }
    } finally {
      stopKeepAlive();
      wordRunning = false;
      hideWordMask();
    }

    const extra = (driveReady ? ' · Drive ✓' : '') + (serverEp ? ' · שרת ✓' : '') + (skipped ? ' · דילג על ' + skipped + ' קיימים' : '');
    if (sessionExpired) {
      setStatus('⚠ פג תוקף הסשן אחרי ' + ok + ' מסמכים. התחבר/י מחדש ונסה/י שוב.' + extra, 'error');
    } else if (state.wordCancel) {
      setStatus('בוטל. ירדו ' + ok + ' מסמכים כ-Word.' + extra);
    } else if (!ok && skipped && !fail && !blocked) {
      // Everything was already in Drive — benign, not an error.
      setStatus('✓ כל ' + skipped + ' המסמכים כבר קיימים ב-Drive — לא הועלו מחדש. (כדי להוריד גם למחשב, ניתן לסמן יעד ZIP בהגדרות.)');
    } else {
      const parts = [];
      if (ok) parts.push(ok + ' מסמכים' + (master ? ' ב-ZIP אחד' : '') + (slow ? ' + אינדקס' : ''));
      if (blocked) parts.push(blocked + ' חסומים ע"י נט המשפט');
      if (fail) parts.push(fail + ' נכשלו');
      setStatus((ok ? '✓ ' : '⚠ ') + 'הסתיים — ' + (parts.join(' · ') || '0 מסמכים') + ' (Word).' + extra +
        (ok ? ' בדוק/י את תיקיית ההורדות.' : ''), ok ? '' : 'error');
    }
  }

  // ── full-screen Word mask (steady overlay across the per-batch reloads) ──
  function showWordMask(text, frac) {
    let m = document.getElementById('cd-word-mask');
    if (!m) {
      m = document.createElement('div');
      m.id = 'cd-word-mask'; m.className = 'cd-collect-mask'; m.dir = 'rtl';
      m.innerHTML = '<div class="cd-collect-mask__card">' +
        '<div class="cd-collect-mask__spin"></div>' +
        '<div class="cd-collect-mask__title">מוריד מסמכי Word…</div>' +
        '<div class="cd-collect-mask__msg" data-cd-wm="msg"></div>' +
        '<div class="cd-collect-mask__bar"><div class="cd-collect-mask__fill" data-cd-wm="fill"></div></div>' +
        '<button type="button" class="cd-collect-mask__cancel" data-cd-wm="cancel">בטל</button>' +
        '</div>';
      (document.body || document.documentElement).appendChild(m);
      const c = m.querySelector('[data-cd-wm="cancel"]');
      if (c) c.addEventListener('click', function () { state.wordCancel = true; });
    }
    if (text != null) { const e = m.querySelector('[data-cd-wm="msg"]'); if (e) e.textContent = text; }
    if (typeof frac === 'number') { const f = m.querySelector('[data-cd-wm="fill"]'); if (f) f.style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + '%'; }
  }
  function hideWordMask() { const m = document.getElementById('cd-word-mask'); if (m && m.parentNode) m.parentNode.removeChild(m); }

  // ── Word/DOC download via the site's native bulk endpoint (≤5 per batch) ──
  async function startDocDownload(chosen) {
    const dests = activeDestinations();
    const caseId = adapter.readCaseId(document) || 'תיק';
    const listLabel = (chosen[0] && chosen[0].docType) || 'מסמכים';
    const nameStem = caseId + ' - ' + listLabel;
    const BATCH = 5; // the site's native limit is 5 marked documents per download
    const totalBatches = Math.ceil(chosen.length / BATCH);
    let ok = 0, fail = 0, batchNum = 0;

    // Optional remote destinations: upload the returned Word/ZIP files too.
    const serverEp = dests.server && state.settings && state.settings.server && state.settings.server.endpoint;
    let driveTargetId = '', driveReady = false;
    if (dests.drive) {
      setStatus('מכין תיקייה ב־Drive: ' + nameStem + '…');
      const parent = (state.settings && state.settings.drive && state.settings.drive.folderId) || '';
      const r = await sendToSW({ type: 'cd/driveEnsureFolder', parentId: parent, name: nameStem });
      if (r && r.ok && r.id) { driveTargetId = r.id; driveReady = true; }
    }
    // When no destination is set (or only localZip), save the files straight to disk.
    const saveToDisk = dests.localZip || (!serverEp && !driveReady);

    for (let i = 0; i < chosen.length; i += BATCH) {
      if (state.cancel) break;
      batchNum++;
      const batch = chosen.slice(i, i + BATCH);
      setStatus('מוריד Word — אצווה ' + batchNum + '/' + totalBatches + ' (' + batch.length + ' מסמכים)…');
      try {
        const req = adapter.getNativeBulkRequest(batch, document);
        const res = await fetch(req.url, { method: 'POST', credentials: 'include', headers: req.headers, body: req.body });
        if (res.status === 401) { setStatus('⚠ פג תוקף הסשן. התחבר/י מחדש לנט המשפט ונסה/י שוב.', 'error'); return; }
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (!res.ok || ct.indexOf('text/html') !== -1 || ct.indexOf('application/json') !== -1) {
          // Not a file → the screen returned an error/redirect instead of Word.
          fail += batch.length; continue;
        }
        const blob = await res.blob();
        if (!blob || blob.size < 64) { fail += batch.length; continue; }
        const fname = sanitize(filenameFromCD(res.headers.get('content-disposition'),
          nameStem + (totalBatches > 1 ? '_' + batchNum : '') + guessExt(ct)), 120);
        if (saveToDisk) saveBlob(blob, fname);
        if (serverEp || driveReady) {
          const bytes = await blob.arrayBuffer();
          if (serverEp) await sendToSW({ type: 'cd/uploadServer', endpoint: serverEp, apiKey: (state.settings.server.apiKey || ''), filename: fname, bytes, mimeType: ct || 'application/octet-stream', meta: { caseId, kind: 'word', docType: listLabel } });
          if (driveReady) await sendToSW({ type: 'cd/uploadDrive', folderId: driveTargetId, filename: fname, bytes, mimeType: ct || 'application/octet-stream' });
        }
        ok += batch.length;
      } catch (e) {
        fail += batch.length;
      }
    }

    const extra = (driveReady ? ' · Drive ✓' : '') + (serverEp ? ' · שרת ✓' : '');
    if (state.cancel) setStatus('בוטל. הורדו ' + ok + ' מסמכים כ-Word.' + extra);
    else setStatus('✓ הסתיים — ' + ok + ' מסמכים כ-Word' + (fail ? ' · ' + fail + ' נכשלו' : '') + extra +
      (totalBatches > 1 ? ' (' + totalBatches + ' קבצים, עד 5 מסמכים בכל אחד)' : ''), fail ? 'error' : '');
  }

  function filenameFromCD(cd, fallback) {
    if (!cd) return fallback;
    let m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    m = cd.match(/filename="?([^";]+)"?/i);
    return m ? m[1].trim() : fallback;
  }
  function guessExt(ct) {
    if (ct.indexOf('zip') !== -1) return '.zip';
    if (ct.indexOf('wordprocessingml') !== -1) return '.docx';
    return '.doc';
  }

  function csvRow(ord, filename, it, status, err) {
    return { 'מס׳': ord, 'שם קובץ': filename, 'סוג מסמך': it.docType || '', 'תאריך': it.date || '', 'גורם': it.submittedBy || '', 'כותרת': it.title || '', 'סטטוס': status, 'שגיאה': err };
  }
  function setDownloadLabel(text) {
    const b = state.els.download; if (!b) return;
    b.childNodes[0] && (b.childNodes[0].nodeValue = text + ' ');
  }
  function finishRun() { stopKeepAlive(); state.busy = false; state.cancel = false; setDownloadLabel('הורד'); refreshCount(); }

  // Binary (PDF/Word/CSV bytes) does NOT survive chrome.runtime.sendMessage to
  // the service worker — it arrives empty, which silently produced EMPTY files
  // in Drive / on the server. Base64-encode any `bytes` field here and decode it
  // in the SW (see b64ToU8 there).
  function u8ToB64(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function sendToSW(message) {
    if (message && (message.bytes instanceof ArrayBuffer || ArrayBuffer.isView(message.bytes))) {
      try {
        message = Object.assign({}, message, { bytesB64: u8ToB64(message.bytes) });
        delete message.bytes;
      } catch (e) { /* fall through with original */ }
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: e.message || String(e) }); }
    });
  }

  // Candidate argument "recipes" for the document postback. The adapter's
  // derived arg (from the page's rendered anchors) is tried first and is
  // correct for most folders; the rest are empirical fallbacks for folders
  // that render no anchors (e.g. פרוטוקולים → bare DocumentID). Once a recipe
  // succeeds for the first document, it's locked for the rest of the run.
  function argRecipes(item) {
    const r = item._raw || {};
    const list = [];
    if (item.postbackArg) list.push({ k: 'derived', arg: item.postbackArg });
    if (r.DocumentID != null) { list.push({ k: 'DocumentID', arg: String(r.DocumentID) }); list.push({ k: 'DocumentID&1', arg: r.DocumentID + '&1' }); }
    if (r.EntityID != null) list.push({ k: 'EntityID', arg: String(r.EntityID) });
    if (r.CaseID != null && r.DocumentID != null) { list.push({ k: 'CaseID&DocumentID', arg: r.CaseID + '&' + r.DocumentID }); list.push({ k: 'CaseID&DocumentID&1', arg: r.CaseID + '&' + r.DocumentID + '&1' }); }
    // de-dup by arg
    const seen = new Set(); return list.filter((x) => x.arg && !seen.has(x.arg) && seen.add(x.arg));
  }

  function buildArgByRecipe(item, recipeKey) {
    const found = argRecipes(item).find((x) => x.k === recipeKey);
    return found ? found.arg : (item.postbackArg || '');
  }

  async function postDocument(item, arg) {
    const form = document.forms[0];
    const body = new URLSearchParams();
    form.querySelectorAll('input[type=hidden]').forEach((inp) => body.append(inp.name, inp.value || ''));
    body.set('__EVENTTARGET', item.postbackTarget || '_ctl0:btnDocument');
    body.set('__EVENTARGUMENT', arg);
    const res = await fetch(form.action, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.status === 401) throw new Error('SESSION_EXPIRED');
    const html = await res.text();
    if (/nidp\/saml2|login\.gov\.il|does not support JavaScript, press the Continue/i.test(html)) throw new Error('SESSION_EXPIRED');
    const m = html.match(/DocumentNumber=([0-9a-f]{32})/i);
    return m ? m[1] : '';
  }

  // Resolve the DocumentNumber. If we've already locked a recipe, use it.
  // Otherwise probe candidate recipes until one yields a DocumentNumber and
  // lock it for subsequent documents.
  async function fetchDocumentNumber(item) {
    if (state.recipe) {
      return await postDocument(item, buildArgByRecipe(item, state.recipe));
    }
    const cands = argRecipes(item);
    for (const c of cands) {
      const dn = await postDocument(item, c.arg);
      if (dn) { state.recipe = c.k; return dn; }
    }
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
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image decode failed'));
      im.src = dataUrl;
    });
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
      pdf.addImage(dataUrl, dataUrl.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG',
        (pageW - dw) / 2, (pageH - dh) / 2, dw, dh, undefined, 'FAST');
    }
    return pdf.output('arraybuffer');
  }

  // ── helpers ────────────────────────────────────────────────────────────
  function sanitize(name, maxLen) {
    return String(name == null ? '' : name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, maxLen || 80);
  }
  // Singular doc-type word for filenames.
  function docTypeWord(label) {
    const map = {
      'החלטות': 'החלטה', 'החלטה': 'החלטה',
      'פסקי דין': 'פסק דין', 'פסק דין': 'פסק דין',
      'פרוטוקולים': 'פרוטוקול', 'פרוטוקול': 'פרוטוקול', 'תמליל': 'תמליל',
      'בקשות': 'בקשה', 'כתבי טענות': 'כתב טענות', 'תצהירים': 'תצהיר',
      'מוצגים': 'מוצג', 'חוות דעת': 'חוות דעת', 'סיכומים': 'סיכומים',
    };
    return map[label] || label || 'מסמך';
  }
  // Normalize any date to YYYY-MM-DD (year first → names sort chronologically).
  function toYmd(d) {
    const s = String(d == null ? '' : d).trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return s.replace(/\//g, '-');
  }
  // Informative base name: "<type> <YYYY-MM-DD> <caseId>" (e.g. "החלטה 2025-02-19 56708-12-22").
  function infoStem(it, caseId) {
    return [docTypeWord(it.docType), toYmd(it.date), caseId].filter(Boolean).join(' ');
  }
  // De-dupe within a run so same-day same-type docs don't overwrite each other.
  const usedNames = Object.create(null);
  function uniqueName(stem, ext) {
    let name = stem + ext, n = 2;
    while (usedNames[name]) { name = stem + ' (' + n + ')' + ext; n++; }
    usedNames[name] = true;
    return name;
  }
  function pdfName(ord, it, caseId) {
    return uniqueName(sanitize(infoStem(it, caseId), 110), '.pdf');
  }
  function toCsv(rows) {
    if (!rows.length) return '﻿';
    const headers = Object.keys(rows[0]);
    const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [headers.map(esc).join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
    return '﻿' + lines.join('\r\n'); // BOM so Excel reads Hebrew UTF-8
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 4000);
  }
})();
