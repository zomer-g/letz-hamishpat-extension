// hearings-panel.js — UI for downloading hearing lists (CSV + ICS) from
// /Ngcs.Web.Secured/Calendar/* pages.
//
// Mirrors list-panel.js (the docs downloader) so users get a consistent UX:
//   • a panel inserted above the AG-Grid
//   • destination chips fed from popup/options settings (ZIP / שרת / Drive)
//   • per-row checkboxes + "סמן הכל" / "נקה" controls
//   • a single primary button that fans out the selected hearings to ALL
//     enabled destinations as both CSV and ICS
//   • settings gear that opens the same options page
//
// What's exported per click:
//   ZIP destination → a single .zip containing:
//                      hearings.csv  (Hebrew headers, matches server-side)
//                      hearings.ics  (combined VCALENDAR, Asia/Jerusalem TZ)
//                      per-hearing/*.ics  (one file per row, stable UIDs)
//   שרת destination → POSTs both hearings.csv and hearings.ics to the
//                      configured endpoint as multipart/form-data (same
//                      handler used by the docs feature).
//   Drive destination → creates folder "יומן דיונים - <tag>" under the
//                       configured parent and uploads hearings.csv +
//                       hearings.ics into it.
//
// User mode (cross-case "הדיונים שלי") additionally shows a from/to date
// row that drives the page's own form postback before reading the grid.

(function () {
  const w = window;
  try { document.documentElement.setAttribute('data-cd-hearingspanel', '1'); } catch (e) {}

  if (/\/Viewer\/NGCSViewerPage\.aspx/i.test(location.pathname)) return;

  const CD = w.CD || {};
  const adapter = CD.adapters && CD.adapters['net-court-hearings'];
  const JSZip = w.JSZip;
  const MAX_RANGE_DAYS = 92; // judge day-by-day collection cap (also bounds the pickers)

  if (!adapter) return;

  // No URL gate — hearings views live under multiple paths (Calendar/,
  // Office/, …). We start the watchdog and let detectMode decide per tick
  // whether to mount. On docs-only pages it stays cheap: a single failed
  // detectMode call per interval.

  const state = {
    mode: null,
    hearings: [],
    selected: new Set(),
    busy: false,
    els: {},
    settings: null,
    obs: null,
    raf: false,
    watchdog: null,
    settingsLoaded: false,
  };

  loadSettings(); // once on script load; gets refreshed in mountPanel too
  startWatchdog();

  // If a judge collection is mid-flight (it survives the per-day page reloads
  // via sessionStorage), mask the page IMMEDIATELY on load — before the grid
  // re-renders — so the user sees a steady overlay instead of flicker.
  try {
    const jj = JSON.parse(sessionStorage.getItem('cd_judge_job') || 'null');
    if (jj && jj.active) {
      const n = (jj.days && jj.days.length) || 1;
      showCollectMask('טוען יום ' + (((jj.collected || 0) + 1)) + '/' + n + '…', (jj.collected || 0) / n);
    }
  } catch (e) {}

  // The watchdog is the only mount path. It runs every 1.5s and:
  //   • mounts the panel if detection succeeds and the panel is missing
  //     (initial page load OR after an ASP.NET postback that wiped it —
  //     this is what happens when you click "הצגת כל הדיונים")
  //   • re-reads hearings if the panel is present (in case row count changed)
  // setInterval is cheap (one querySelector + a few regex tests per tick).
  // We keep it running for the life of the tab; on docs-only pages it
  // does ~zero work because detectMode returns null fast.
  function startWatchdog() {
    if (state.watchdog) return;
    const tick = () => {
      if (state.busy) return;
      const panelInDom = document.querySelector('.cd-panel[data-cd-hearings]');
      const mode = adapter.detectMode(document, location);

      if (!mode) {
        // We left a hearings page (or never were on one). Tear down panel
        // if it's still around from a previous tab.
        if (panelInDom && !state.busy) {
          try { panelInDom.remove(); } catch (e) {}
          if (state.obs) { try { state.obs.disconnect(); } catch (e) {} state.obs = null; }
          state.selected.clear();
        }
        return;
      }

      state.mode = mode;

      // ── Judge-report mode: a day-by-day range collector that survives the
      // full-page postbacks the report triggers (state in sessionStorage). ──
      if (mode === 'judge') {
        if (!panelInDom) { mountPanel(); }
        judgeOnMount();
        return;
      }

      // We're on a hearings page (case/user). Refresh data either way.
      const fresh = adapter.listAllHearings(document);
      const countChanged = fresh.length !== state.hearings.length;
      state.hearings = fresh;

      if (!panelInDom) {
        // Either first load, or postback wiped us. Re-mount.
        mountPanel();
        attachObserver();
        selectAll(false);
        return;
      }

      // Panel is present. Sync row checkboxes & counters.
      if (countChanged) {
        const valid = new Set(state.hearings.map((h, i) => adapter.hearingId(h, i)));
        for (const id of state.selected) if (!valid.has(id)) state.selected.delete(id);
        // New rows default to selected (matches the "select-all" default).
        for (let i = 0; i < state.hearings.length; i++) {
          state.selected.add(adapter.hearingId(state.hearings[i], i));
        }
        refreshCounts();
      }
      syncRowCheckboxes();
    };
    state.watchdog = setInterval(tick, 1500);
    // Also run once immediately so the panel can appear faster than 1.5s.
    setTimeout(tick, 100);
  }

  function loadSettings() {
    if (w.CD && w.CD.getSettings) {
      w.CD.getSettings().then((s) => { state.settings = s; renderDestChips(); });
    }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.cd_settings && w.CD && w.CD.getSettings) {
          w.CD.getSettings().then((s) => { state.settings = s; renderDestChips(); });
        }
      });
    } catch (e) {}
  }

  function attachObserver() {
    // Disconnect any prior observer so multiple re-mounts don't stack
    // observers (each one would re-fire on every grid mutation).
    if (state.obs) { try { state.obs.disconnect(); } catch (e) {} state.obs = null; }
    const target = adapter.findGridRoot(document) || document.body;
    state.obs = new MutationObserver(() => {
      if (state.raf) return;
      state.raf = true;
      requestAnimationFrame(() => {
        state.raf = false;
        const fresh = adapter.listAllHearings(document);
        // Refresh only on count change to avoid thrash on hover tooltips.
        if (fresh.length !== state.hearings.length) {
          state.hearings = fresh;
          // Drop selections that no longer exist; auto-select new rows so
          // the default "everything is picked" intent survives refreshes.
          const valid = new Set(state.hearings.map((h, i) => adapter.hearingId(h, i)));
          for (const id of state.selected) if (!valid.has(id)) state.selected.delete(id);
          for (let i = 0; i < state.hearings.length; i++) {
            state.selected.add(adapter.hearingId(state.hearings[i], i));
          }
          syncRowCheckboxes();
          refreshCounts();
        } else {
          syncRowCheckboxes();
        }
      });
    });
    state.obs.observe(target, { childList: true, subtree: true });
  }

  // ── panel ────────────────────────────────────────────────────────────
  function mountPanel() {
    if (document.querySelector('.cd-panel[data-cd-hearings]')) {
      bindPanel(document.querySelector('.cd-panel[data-cd-hearings]'));
      if (state.mode !== 'judge') syncRowCheckboxes();
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'cd-panel';
    panel.setAttribute('data-cd-hearings', '1');
    panel.dir = 'rtl';
    panel.innerHTML = state.mode === 'judge' ? judgePanelHtml() : gridPanelHtml();

    // Anchor above the actual hearings grid (not the first grid on the page —
    // the dashboard has several), so the panel lands inside the right modal.
    const gridRoot = adapter.findHearingsGrid(document) || adapter.findGridRoot(document) ||
      document.querySelector('[id$="Grid"]') || document.querySelector('[role="grid"]');
    if (gridRoot && gridRoot.parentElement) {
      gridRoot.parentElement.insertBefore(panel, gridRoot);
      // Align the panel to the grid below it. The panel and grid are now
      // siblings (same offsetParent), so matching the grid's WIDTH *and* its
      // horizontal offset makes their edges line up exactly — centering with
      // `margin:auto` would drift left when the grid isn't centered in the cell
      // (e.g. the "דיונים שלי" modal).
      const gw = gridRoot.offsetWidth;
      if (gw) {
        panel.style.width = gw + 'px';
        panel.style.boxSizing = 'border-box';
        panel.style.margin = '6px 0';
        panel.style.marginLeft = gridRoot.offsetLeft + 'px';
      }
    } else {
      document.body.insertBefore(panel, document.body.firstChild);
    }

    bindPanel(panel);
    // Settings may have loaded BEFORE the panel existed (we loadSettings on
    // script start). Render chips now that the host element is in the DOM.
    if (state.settings) renderDestChips();
    if (state.mode !== 'judge') { syncRowCheckboxes(); refreshCounts(); }
  }

  // Panel HTML for case/user modes (grid-row selection + export).
  function gridPanelHtml() {
    const title = state.mode === 'user' ? '📅 ייצוא יומן דיונים' : '📅 ייצוא מועדי דיון';
    const dateRangeHtml = state.mode === 'user'
      ? '<div class="cd-panel__hr-range">' +
          '<label>מ־ <input type="text" data-cd-hr="from" placeholder="dd/mm/yyyy" size="10"></label>' +
          '<label>עד <input type="text" data-cd-hr="to" placeholder="dd/mm/yyyy" size="10"></label>' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--primary" data-action="apply-range">החלת טווח</button>' +
          '<span class="cd-panel__hint">(לאחר רענון הטבלה — לחיצה על "הורדה")</span>' +
        '</div>'
      : '';
    return '<div class="cd-panel__bar">' +
        '<div class="cd-panel__title">' + title +
          '<span class="cd-panel__count" data-cd-hr="total">' + state.hearings.length + ' דיונים</span>' +
        '</div>' +
        '<span data-cd-hr="dests"></span>' +
        '<div class="cd-panel__actions">' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--ghost" data-action="all">סימון הכל</button>' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--ghost" data-action="clear">ניקוי</button>' +
          '<button type="button" class="cd-panel__btn cd-panel__btn--primary" data-action="download" disabled>' +
            'הורדה <span class="cd-panel__count" data-cd-hr="count">0</span></button>' +
          '<button type="button" class="cd-panel__btn" data-action="cal-sync" title="סנכרון הדיונים ליומן Google">🔄 ל-Google</button>' +
          '<button type="button" class="cd-panel__btn cd-panel__gear" data-action="settings" title="הגדרות">⚙</button>' +
        '</div>' +
        '<button type="button" class="cd-panel__btn cd-panel__close" data-action="close" aria-label="הסתרה">×</button>' +
      '</div>' +
      dateRangeHtml +
      '<div class="cd-panel__status idle" data-cd-hr="status">' +
        'ניתן לסמן דיונים וללחוץ "הורדה". הקבצים (CSV + ICS) יישלחו ליעדים שהוגדרו (כברירת מחדל: ZIP למחשב). ' +
        'ה-ICS ניתן לייבא ישירות ל-Google Calendar.' +
      '</div>';
  }

  // Panel HTML for judge-report mode (court+judge readout, range collector).
  function judgePanelHtml() {
    const ctx = adapter.judgeContext(document);
    const readout = [ctx.courtName, ctx.judgeName].filter(Boolean).join(' · ') || 'יש לבחור בית משפט ושופט/ת בעמוד נט המשפט';
    return '<div class="cd-panel__bar">' +
        '<div class="cd-panel__title">📅 יומן דיונים לשופט/ת' +
          '<span class="cd-panel__count" data-cd-hr="total">0 דיונים</span>' +
        '</div>' +
        '<span class="cd-panel__judge-readout" data-cd-hr="judge">⚖️ נבחרו בעמוד: ' + escapeHtml(readout) + '</span>' +
        '<button type="button" class="cd-panel__btn cd-panel__close" data-action="close" aria-label="הסתרה">×</button>' +
      '</div>' +
      // Row 1 — date range only.
      '<div class="cd-panel__hr-range">' +
        '<span class="cd-panel__range-label">📆 טווח תאריכים:</span>' +
        '<label>מ־ <input type="text" data-cd-hr="from" placeholder="dd/mm/yyyy" size="10"></label>' +
        '<label>עד <input type="text" data-cd-hr="to" placeholder="dd/mm/yyyy" size="10"></label>' +
      '</div>' +
      // Row 2 — all the actions.
      '<div class="cd-panel__hr-actions">' +
        '<span data-cd-hr="dests"></span>' +
        '<button type="button" class="cd-panel__btn" data-action="calview" title="תצוגת יומן צף לדיוני השופט/ת">📅 תצוגת יומן</button>' +
        '<button type="button" class="cd-panel__btn cd-panel__btn--primary" data-action="download">⬇ הורדה</button>' +
        '<button type="button" class="cd-panel__btn cd-panel__gear" data-action="settings" title="הגדרות">⚙ הגדרות</button>' +
      '</div>' +
      '<div class="cd-panel__status idle" data-cd-hr="status">' +
        'בית המשפט והשופט/ת נבחרים בעמוד נט המשפט (למעלה); כאן בוחרים טווח תאריכים, ' +
        'ואז תצוגת יומן או הורדה — איסוף הדיונים מתבצע אוטומטית.' +
      '</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function bindPanel(panel) {
    state.els.panel = panel;
    state.els.status = panel.querySelector('[data-cd-hr="status"]');
    state.els.total = panel.querySelector('[data-cd-hr="total"]');
    state.els.count = panel.querySelector('[data-cd-hr="count"]');
    state.els.dests = panel.querySelector('[data-cd-hr="dests"]');
    state.els.from = panel.querySelector('[data-cd-hr="from"]');
    state.els.to = panel.querySelector('[data-cd-hr="to"]');
    state.els.download = panel.querySelector('[data-action="download"]');
    state.els.judge = panel.querySelector('[data-cd-hr="judge"]');
    state.els.collect = panel.querySelector('[data-action="collect"]');
    state.els.cancelCollect = panel.querySelector('[data-action="cancel-collect"]');
    // Replace manual date typing with the click-only calendar popup. Runs on
    // every (re)mount; attachDatePicker is idempotent per element.
    if (w.CD && w.CD.attachDatePicker) {
      if (state.els.from) w.CD.attachDatePicker(state.els.from);
      if (state.els.to) w.CD.attachDatePicker(state.els.to);
    }
    bindRangeBounds();
    if (panel.dataset.cdBound) return;
    panel.dataset.cdBound = '1';
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === 'close') { panel.remove(); if (state.obs) state.obs.disconnect(); judgeCancel(); }
      else if (a === 'all') selectAll(true);
      else if (a === 'clear') clearSelection();
      else if (a === 'apply-range') applyDateRange();
      // In judge mode every action auto-collects the range first (no separate
      // "collect" step); in case/user mode the actions work on the selection.
      else if (a === 'download') { if (state.mode === 'judge') judgeAction('download'); else startDownload(); }
      else if (a === 'calview') judgeAction('calview');
      else if (a === 'cal-sync') { if (state.mode === 'judge') judgeAction('sync'); else panelCalSync(); }
      else if (a === 'settings') { try { chrome.runtime.sendMessage({ type: 'cd/openOptions' }); } catch (e) {} }
    });
  }

  // The hearings currently chosen for export: the checkbox selection in
  // case/user mode, or the whole collected set in judge mode.
  function getChosenHearings() {
    if (state.mode === 'judge') return (state.hearings || []).slice();
    const all = adapter.listAllHearings(document);
    state.hearings = all;
    const chosen = [];
    for (let i = 0; i < all.length; i++) {
      if (state.selected.has(adapter.hearingId(all[i], i))) chosen.push(all[i]);
    }
    return chosen;
  }

  // Sync ONLY the hearings shown in this panel (e.g. one specific case) to the
  // configured Google Calendar — the per-case counterpart of the global
  // header button (which syncs all of the user's hearings).
  async function panelCalSync() {
    if (state.busy) return;
    const cs = (state.settings && state.settings.calendarSync) || {};
    if (!cs.calendarId) {
      setStatus('יש להגדיר יומן יעד בהגדרות התוסף (לשונית "יומן Google") ואז לנסות שוב.', 'error');
      try { chrome.runtime.sendMessage({ type: 'cd/openOptions' }); } catch (e) {}
      return;
    }
    const chosen = getChosenHearings();
    if (!chosen.length) { setStatus('לא נמצאו דיונים לסנכרון.', 'error'); return; }
    const fmt = { titleTemplate: cs.titleTemplate, locationTemplate: cs.locationTemplate, descriptionTemplate: cs.descriptionTemplate };
    const events = chosen.map((h) => w.CD.gcalEvent(h, fmt)).filter(Boolean);
    if (!events.length) { setStatus('אין דיונים עם תאריך תקין לסנכרון.', 'error'); return; }

    state.busy = true;
    setStatus('מסנכרן ' + events.length + ' דיונים ליומן "' + (cs.calendarName || '') + '"…');
    try {
      const r = await sendToSW({ type: 'cd/calSyncEvents', calendarId: cs.calendarId, events: events });
      if (r && r.ok) {
        if (w.CD && w.CD.saveSettings) {
          state.settings = await w.CD.saveSettings({ calendarSync: { lastSyncAt: Date.now(), lastSyncCount: r.synced || 0 } });
        }
        setStatus('✓ סונכרנו ' + (r.synced || 0) + ' דיונים ליומן "' + (cs.calendarName || '') + '"' + (r.failed ? ' · ' + r.failed + ' נכשלו' : ''));
      } else {
        setStatus('סנכרון נכשל: ' + String((r && r.error) || 'שגיאה').slice(0, 100), 'error');
      }
    } catch (e) {
      setStatus('סנכרון נכשל: ' + ((e && e.message) || String(e)), 'error');
    } finally {
      state.busy = false;
    }
  }

  // Open the floating judge-calendar window. If hearings haven't been collected
  // yet, start the collection automatically (the user shouldn't have to click
  // "אסוף" separately) and open the window when it finishes.
  function openJudgeCalendar() {
    const have = (state.hearings || []).filter((h) => h && h.date);
    if (have.length && state.judgeCollected) { showJudgeCalendar(); return; }
    const running = readJob();
    if (running && running.active) {
      running.openCalWhenDone = true; writeJob(running);
      setStatus('האיסוף כבר רץ — תצוגת היומן תיפתח אוטומטית בסיום.');
      return;
    }
    // Not collected yet → collect now and auto-open on finish.
    judgeStart({ openCalWhenDone: true });
  }

  function showJudgeCalendar() {
    const hearings = (state.hearings || []).filter((h) => h && h.date);
    if (!hearings.length) { setStatus('לא נאספו דיונים להצגה.', 'error'); return; }
    if (w.CD && w.CD.openJudgeCalendar) {
      w.CD.openJudgeCalendar(hearings, state.judgeMeta || {}, state.settings || {});
    } else {
      setStatus('מודול היומן לא נטען — ניתן לרענן את העמוד ולנסות שוב.', 'error');
    }
  }

  // Judge mode: pick an action; collect the date range first (automatically) if
  // it hasn't been collected yet, then run the action. No separate "collect"
  // step — the user just chooses calendar / download / sync.
  async function judgeAction(action) {
    // For sync, settle the (dedicated) Google calendar UP FRONT so the user
    // isn't surprised by a dialog after the collection finishes.
    if (action === 'sync') { const ok = await ensureJudgeCalendar(); if (!ok) return; }
    const have = state.judgeCollected && state.hearings && state.hearings.some((h) => h && h.date);
    if (have) { runJudgeAction(action); return; }
    const running = readJob();
    if (running && running.active) {
      running.thenAction = action; writeJob(running);
      setStatus('האיסוף כבר רץ — הפעולה תתבצע אוטומטית בסיומו.');
      return;
    }
    judgeStart({ thenAction: action });
  }

  function runJudgeAction(action) {
    if (action === 'calview') showJudgeCalendar();
    else if (action === 'download') startDownload();
    else if (action === 'sync') panelCalSyncJudge();
  }

  // Offer (once) to create a dedicated Google calendar "layer" for the judge's
  // hearings — separate from the personal calendar configured in options. If the
  // user declines, fall back to the personal calendar (if one is configured).
  async function ensureJudgeCalendar() {
    if (w.CD && w.CD.getSettings) state.settings = await w.CD.getSettings();
    const jc = (state.settings && state.settings.judgeCalSync) || {};
    if (jc.calendarId) return true; // dedicated judge calendar already exists
    const cs = (state.settings && state.settings.calendarSync) || {};
    const hasPersonal = !!cs.calendarId;
    const make = window.confirm(
      'לסנכרון דיוני השופט/ת מומלץ יומן ייעודי נפרד ב-Google Calendar — שכבה משלו, שאפשר להציג/להסתיר.\n\n' +
      'ליצור עכשיו יומן ייעודי בשם "נט המשפט — דיוני שופט/ת"?' +
      (hasPersonal ? '\n\n(ביטול = סנכרון ליומן שכבר מוגדר בהגדרות התוסף.)' : ''));
    if (make) {
      setStatus('יוצר יומן ייעודי ב-Google Calendar…');
      const r = await sendToSW({ type: 'cd/calCreateCalendar', summary: 'נט המשפט — דיוני שופט/ת' });
      if (!(r && r.ok && r.id)) { setStatus('יצירת היומן נכשלה: ' + String((r && r.error) || 'שגיאה').slice(0, 100), 'error'); return false; }
      if (w.CD && w.CD.saveSettings) {
        state.settings = await w.CD.saveSettings({ judgeCalSync: { calendarId: r.id, calendarName: r.summary || 'נט המשפט — דיוני שופט/ת' } });
      }
      return true;
    }
    if (!hasPersonal) {
      setStatus('לא הוגדר יומן יעד. ניתן ליצור יומן ייעודי, או להגדיר יומן בהגדרות התוסף (חיבור ל-Google).', 'error');
      try { chrome.runtime.sendMessage({ type: 'cd/openOptions' }); } catch (e) {}
      return false;
    }
    return true; // use the personal calendar
  }

  // Sync the collected judge hearings into the dedicated judge calendar (or the
  // personal one as a fallback). The target is settled by ensureJudgeCalendar().
  async function panelCalSyncJudge() {
    if (state.busy) return;
    if (w.CD && w.CD.getSettings) state.settings = await w.CD.getSettings();
    const jc = (state.settings && state.settings.judgeCalSync) || {};
    const cs = (state.settings && state.settings.calendarSync) || {};
    const target = jc.calendarId ? jc : cs;
    if (!target.calendarId) { setStatus('לא הוגדר יומן יעד לסנכרון.', 'error'); return; }
    const chosen = getChosenHearings();
    if (!chosen.length) { setStatus('לא נמצאו דיונים לסנכרון.', 'error'); return; }
    const fmt = { titleTemplate: cs.titleTemplate, locationTemplate: cs.locationTemplate, descriptionTemplate: cs.descriptionTemplate };
    const events = chosen.map((h) => w.CD.gcalEvent(h, fmt)).filter(Boolean);
    if (!events.length) { setStatus('אין דיונים עם תאריך תקין לסנכרון.', 'error'); return; }
    state.busy = true;
    setStatus('מסנכרן ' + events.length + ' דיונים ליומן "' + (target.calendarName || '') + '"…');
    try {
      const r = await sendToSW({ type: 'cd/calSyncEvents', calendarId: target.calendarId, events: events });
      if (r && r.ok) setStatus('✓ סונכרנו ' + (r.synced || 0) + ' דיונים ליומן "' + (target.calendarName || '') + '"' + (r.failed ? ' · ' + r.failed + ' נכשלו' : ''));
      else setStatus('הסנכרון נכשל: ' + String((r && r.error) || 'שגיאה').slice(0, 100), 'error');
    } catch (e) { setStatus('הסנכרון נכשל: ' + ((e && e.message) || String(e)), 'error'); }
    finally { state.busy = false; }
  }

  // ── full-screen collecting mask (anti-flicker during day-by-day reloads) ──
  function showCollectMask(text, frac) {
    let m = document.getElementById('cd-collect-mask');
    if (!m) {
      m = document.createElement('div');
      m.id = 'cd-collect-mask';
      m.className = 'cd-collect-mask';
      m.dir = 'rtl';
      m.innerHTML =
        '<div class="cd-collect-mask__card">' +
          '<div class="cd-collect-mask__spin"></div>' +
          '<div class="cd-collect-mask__title">אוסף דיונים לשופט…</div>' +
          '<div class="cd-collect-mask__msg" data-cd-mask="msg"></div>' +
          '<div class="cd-collect-mask__bar"><div class="cd-collect-mask__fill" data-cd-mask="fill"></div></div>' +
          '<button type="button" class="cd-collect-mask__cancel" data-cd-mask="cancel">בטל איסוף</button>' +
        '</div>';
      (document.body || document.documentElement).appendChild(m);
      const cancel = m.querySelector('[data-cd-mask="cancel"]');
      if (cancel) cancel.addEventListener('click', () => { judgeCancel(); });
    }
    if (text != null) { const e = m.querySelector('[data-cd-mask="msg"]'); if (e) e.textContent = text; }
    if (typeof frac === 'number') {
      const f = m.querySelector('[data-cd-mask="fill"]');
      if (f) f.style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + '%';
    }
  }
  function hideCollectMask() {
    const m = document.getElementById('cd-collect-mask');
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  // ── judge date-range bounds (cap the collectable window in the pickers) ──
  function jpAddDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function jpParse(s) { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; }
  function jpFmt(d) { return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear(); }

  // After one date is chosen, constrain the OTHER field's picker to the legal
  // window (≤ MAX_RANGE_DAYS inclusive), and clear a now-illegal counterpart.
  function updateRangeBounds() {
    const fromEl = state.els.from, toEl = state.els.to;
    if (!fromEl || !toEl) return;
    const off = MAX_RANGE_DAYS - 1;
    const from = jpParse(fromEl.value);
    if (from) {
      toEl.dataset.cdMin = jpFmt(from);
      toEl.dataset.cdMax = jpFmt(jpAddDays(from, off));
      const to = jpParse(toEl.value);
      if (to && (to < from || to > jpAddDays(from, off))) toEl.value = '';
    } else { delete toEl.dataset.cdMin; delete toEl.dataset.cdMax; }
    const to2 = jpParse(toEl.value);
    if (to2) {
      fromEl.dataset.cdMax = jpFmt(to2);
      fromEl.dataset.cdMin = jpFmt(jpAddDays(to2, -off));
      const from2 = jpParse(fromEl.value);
      if (from2 && (from2 > to2 || from2 < jpAddDays(to2, -off))) fromEl.value = '';
    } else { delete fromEl.dataset.cdMax; delete fromEl.dataset.cdMin; }
  }
  function bindRangeBounds() {
    if (state.mode !== 'judge') return;
    ['from', 'to'].forEach((which) => {
      const el = state.els[which];
      if (el && !el.dataset.cdBoundRange) {
        el.dataset.cdBoundRange = '1';
        el.addEventListener('change', updateRangeBounds);
      }
    });
    updateRangeBounds();
  }

  function setStatus(text, kind) {
    const el = state.els.status; if (!el) return;
    el.textContent = text;
    el.classList.remove('idle', 'error'); if (kind) el.classList.add(kind);
  }

  function refreshCounts() {
    if (state.els.count) state.els.count.textContent = String(state.selected.size);
    if (state.els.total) state.els.total.textContent = state.hearings.length + ' דיונים';
    if (state.els.download) state.els.download.disabled = !state.busy && state.selected.size === 0;
  }

  // Hearings have their OWN destination profile, separate from documents.
  // CD.getProfile(settings, 'hearings') resolves it (with defaults) from the
  // `hearings` block in storage. Documents keep reading top-level settings.
  function profile() {
    if (w.CD && w.CD.getProfile) return w.CD.getProfile(state.settings, 'hearings');
    // Fallback if settings.js helper is unavailable: read the hearings block
    // directly, else fall back to ZIP-only.
    const h = (state.settings && state.settings.hearings) || {};
    return {
      destinations: h.destinations || { localZip: true, server: false, drive: false },
      server: h.server || { endpoint: '', apiKey: '' },
      drive: h.drive || { folderId: '', folderName: '' },
    };
  }

  function activeDestinations() {
    const d = profile().destinations || { localZip: true };
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

  // ── selection ────────────────────────────────────────────────────────
  function selectAll(announce) {
    state.hearings = adapter.listAllHearings(document);
    state.selected = new Set(state.hearings.map((h, i) => adapter.hearingId(h, i)));
    syncRowCheckboxes();
    refreshCounts();
    if (announce) setStatus('נבחרו ' + state.selected.size + ' דיונים');
  }

  function clearSelection() {
    state.selected.clear();
    syncRowCheckboxes();
    refreshCounts();
    setStatus('הבחירה נמחקה', 'idle');
  }

  // Inject a checkbox into each AG-Grid row's first cell. The row-index
  // attribute maps to our hearings[] order — AG-Grid renders only visible
  // rows so we re-run this on every observer tick.
  function syncRowCheckboxes() {
    const grid = adapter.findGridRoot(document);
    if (!grid) return;
    const rowEls = Array.from(grid.querySelectorAll('.ag-center-cols-container [role="row"][row-index]'));
    for (const rowEl of rowEls) {
      const rowIndex = parseInt(rowEl.getAttribute('row-index'), 10);
      const h = state.hearings[rowIndex];
      if (!h) continue;
      const id = adapter.hearingId(h, rowIndex);
      let cb = rowEl.querySelector('.cd-row-cb');
      if (!cb) {
        const cell = rowEl.querySelector('[role="gridcell"]'); if (!cell) continue;
        cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'cd-row-cb'; cb.title = 'לבחירה להורדה';
        cb.addEventListener('click', (ev) => ev.stopPropagation());
        cb.addEventListener('change', () => {
          if (cb.checked) state.selected.add(cb.dataset.cdId);
          else state.selected.delete(cb.dataset.cdId);
          refreshCounts();
        });
        cell.insertBefore(cb, cell.firstChild);
      }
      cb.dataset.cdId = id;
      const should = state.selected.has(id);
      if (cb.checked !== should) cb.checked = should;
    }
  }

  // ── date range (user mode) ───────────────────────────────────────────
  function applyDateRange() {
    const from = state.els.from && state.els.from.value.trim();
    const to = state.els.to && state.els.to.value.trim();
    if (!from || !to) { setStatus('יש למלא תאריך התחלה ותאריך סיום (dd/mm/yyyy).', 'error'); return; }
    setStatus('דוחף טווח לעמוד ומפעיל דוח…');
    const setRes = adapter.setDateRange(document, from, to);
    if (!setRes.from || !setRes.to) {
      setStatus('לא נמצאו שדות תאריך בעמוד. ייתכן שהממשק השתנה — מלא ידנית והפעל את הדוח מהעמוד.', 'error');
      return;
    }
    const ok = adapter.triggerReport(document);
    if (!ok) {
      setStatus('לא נמצא כפתור הפעלת הדוח. ניתן להפעיל ידנית מהעמוד, ולאחר רענון הטבלה — ללחוץ "הורדה".', 'error');
      return;
    }
    setStatus('הדוח רץ. כשהטבלה מתרעננת — ניתן לסמן/לנקות וללחוץ "הורדה".');
  }

  // ── judge-report range collector (day-by-day, survives page reloads) ──
  //
  // The "דיונים לשופט ליום דיונים" report only shows ONE day at a time, and
  // running a day triggers a FULL ASP.NET postback (the page reloads). To
  // collect a whole range we drive it the way a human would — set the date,
  // submit, read the day's grid, advance — but persist the job in
  // sessionStorage so it survives each reload. The watchdog re-mounts the
  // panel after every reload and calls judgeOnMount(), which resumes the job:
  // it harvests the day now showing, appends to the accumulator, and submits
  // the next day (or finishes). sessionStorage is per-tab and auto-clears
  // when the tab closes.
  const JUDGE_JOB_KEY = 'cd_judge_job';

  // One harvest per page instance. Content scripts re-run on every full
  // reload, so this module-level flag resets to false each load — exactly
  // once per day the report shows. It guards against the 1.5s watchdog
  // harvesting the same page twice (which would skip a day).
  let judgeHandledThisLoad = false;

  function readJob() {
    try { return JSON.parse(sessionStorage.getItem(JUDGE_JOB_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeJob(job) {
    try { sessionStorage.setItem(JUDGE_JOB_KEY, JSON.stringify(job)); } catch (e) {}
  }
  function clearJob() {
    try { sessionStorage.removeItem(JUDGE_JOB_KEY); } catch (e) {}
  }

  // Build inclusive list of "dd/mm/yyyy" strings between two such dates.
  function enumerateDays(fromStr, toStr) {
    const p = (s) => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
    const a = p(fromStr), b = p(toStr);
    if (!a || !b || a > b) return null;
    const out = [];
    const cur = new Date(a.getTime());
    let guard = 0;
    while (cur <= b && guard < 800) {
      const dd = ('0' + cur.getDate()).slice(-2);
      const mm = ('0' + (cur.getMonth() + 1)).slice(-2);
      out.push(dd + '/' + mm + '/' + cur.getFullYear());
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return out;
  }

  // Returns true if a collection job was started. opts.openCalWhenDone makes
  // the floating calendar open automatically once collection finishes.
  function judgeStart(opts) {
    opts = opts || {};
    if (readJob()) { setStatus('איסוף כבר רץ — יש להמתין לסיומו (או לבטל בחלון האיסוף).', 'error'); return false; }
    const from = state.els.from && state.els.from.value.trim();
    const to = state.els.to && state.els.to.value.trim();
    if (!from || !to) { setStatus('יש לבחור תאריך התחלה וסיום (לחיצה על שדה התאריך פותחת לוח שנה).', 'error'); return false; }
    const days = enumerateDays(from, to);
    if (!days) { setStatus('טווח תאריכים לא תקין (ההתחלה חייבת להיות לפני הסיום).', 'error'); return false; }
    if (days.length > MAX_RANGE_DAYS) { setStatus('הטווח גדול מ-' + MAX_RANGE_DAYS + ' ימים. יש לבחור טווח קצר יותר.', 'error'); return false; }

    const ctx = adapter.judgeContext(document);
    if (!ctx.judgeValue && !ctx.judgeName) {
      setStatus('יש לבחור שופט/ת (גורם שיפוטי) בעמוד לפני האיסוף.', 'error'); return false;
    }
    const job = {
      active: true,
      days: days,
      collected: 0,           // index of the day we're about to harvest
      rows: [],               // accumulated hearings across days
      from: from, to: to,
      courtName: ctx.courtName, judgeName: ctx.judgeName,
      // What to do once the whole range is collected: 'calview' | 'download' | 'sync'.
      thenAction: opts.thenAction || (opts.openCalWhenDone ? 'calview' : null),
    };
    writeJob(job);
    const startMsg = 'מתחיל איסוף: ' + days.length + ' ימים עבור ' + (ctx.judgeName || 'השופט שנבחר') + '…';
    setStatus(startMsg);
    showCollectMask(startMsg, 0);
    if (state.els.collect) state.els.collect.style.display = 'none';
    if (state.els.cancelCollect) state.els.cancelCollect.style.display = '';
    // This page instance must NOT harvest (it shows a stale day). The harvest
    // of days[0] happens after the reload below brings the day-0 report.
    judgeHandledThisLoad = true;
    // Submit day 0; the page will reload and judgeOnMount() resumes.
    if (!adapter.submitJudgeReport(document, days[0])) {
      clearJob();
      hideCollectMask();
      judgeHandledThisLoad = false;
      if (state.els.collect) state.els.collect.style.display = '';
      if (state.els.cancelCollect) state.els.cancelCollect.style.display = 'none';
      setStatus('לא הצלחתי להפעיל את הדו"ח (לא נמצא שדה תאריך/כפתור). הפעל ידנית.', 'error');
      return false;
    }
    return true;
  }

  // Called by the watchdog on every (re)mount while in judge mode.
  async function judgeOnMount() {
    const job = readJob();
    // Reflect collect/cancel button visibility.
    if (state.els.collect) state.els.collect.style.display = job && job.active ? 'none' : '';
    if (state.els.cancelCollect) state.els.cancelCollect.style.display = job && job.active ? '' : 'none';

    if (!job || !job.active) {
      // Idle: keep the court/judge readout fresh.
      refreshJudgeReadout();
      return;
    }

    // Already harvested this page instance — wait for the reload triggered by
    // the last submit. (The watchdog ticks faster than a page reload.)
    if (judgeHandledThisLoad) return;
    judgeHandledThisLoad = true;

    // Resume: the grid now shows job.days[job.collected]. Harvest it once the
    // grid has finished rendering (the report loads async after the postback).
    const day = job.days[job.collected];
    const loadMsg = 'טוען יום ' + (job.collected + 1) + '/' + job.days.length + ' (' + day + ')…';
    setStatus(loadMsg);
    showCollectMask(loadMsg, job.collected / job.days.length);
    const rows = await harvestCurrentDay();
    for (const r of rows) { if (!r.date) r.date = day; }
    job.rows.push.apply(job.rows, rows);
    job.collected++;
    writeJob(job);

    if (job.collected < job.days.length) {
      const progMsg = 'אוסף יום ' + job.collected + '/' + job.days.length +
        ' (' + day + '): נאספו ' + job.rows.length + ' דיונים…';
      setStatus(progMsg);
      showCollectMask(progMsg, job.collected / job.days.length);
      // Submit the next day → full reload → judgeOnMount() again.
      if (!adapter.submitJudgeReport(document, job.days[job.collected])) {
        job.active = false; writeJob(job);
        judgeFinish(job, 'נעצר — לא ניתן להפעיל את הדו"ח ליום הבא.');
      }
    } else {
      job.active = false; writeJob(job);
      judgeFinish(job, '');
    }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Wait until the day's grid has settled: either rows are present, or the
  // AG-Grid "no rows" overlay is showing (an empty docket day), or timeout.
  async function waitGridReady(maxMs) {
    const deadline = Date.now() + (maxMs || 6000);
    while (Date.now() < deadline) {
      const grid = adapter.findGridRoot(document);
      if (grid) {
        const hasRows = grid.querySelector('.ag-center-cols-container [role="row"][row-index]');
        const noRows = grid.querySelector('.ag-overlay-no-rows-to-show, .ag-overlay-no-rows-center');
        if (hasRows || noRows) return;
      }
      // Also accept an ArrayStore that already carries data.
      await sleep(200);
    }
  }

  // Read the AG-Grid paging total ("X עד Y מתוך Z" → Z), or null if absent.
  function readPagingTotal() {
    const grid = adapter.findGridRoot(document) || document;
    const panel = grid.querySelector('.ag-paging-row-summary-panel');
    if (!panel) return null;
    const m = (panel.textContent || '').match(/(\d+)\s*עד\s*(\d+)\s*מתוך\s*(\d+)/);
    return m ? parseInt(m[3], 10) : null;
  }

  function clickGridNextPage() {
    const grid = adapter.findGridRoot(document) || document;
    let btn = grid.querySelector('.ag-paging-button [ref="btNext"], button[ref="btNext"], [ref="btNext"]');
    if (!btn) {
      const cands = grid.querySelectorAll('.ag-paging-button, button');
      for (const c of cands) { if ((c.textContent || '').indexOf('לדף הבא') > -1) { btn = c; break; } }
    }
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  }

  // Collect all hearings for the currently-shown day. Prefers the ArrayStore
  // (which holds every row regardless of paging); if the grid is DOM-only and
  // paginated, pages through it client-side (no postback) like hearing_scraper.
  async function harvestCurrentDay() {
    await waitGridReady();
    let rows = adapter.listAllHearings(document);
    const total = readPagingTotal();
    // If we already have everything (ArrayStore) or there's no paging info,
    // we're done. Otherwise page through to gather the rest.
    if (total == null || rows.length >= total) return rows;

    const map = new Map();
    const sig = (h) => (h.caseId || '') + '|' + (h.time || '') + '|' + (h.sittingType || '') + '|' + (h.caseName || '');
    rows.forEach((h) => map.set(sig(h), h));
    let guard = 0;
    while (map.size < total && guard < 80) {
      if (!clickGridNextPage()) break;
      await sleep(450);
      adapter.listAllHearings(document).forEach((h) => map.set(sig(h), h));
      guard++;
    }
    return Array.from(map.values());
  }

  function judgeFinish(job, note) {
    // Dedupe (a day may rarely be harvested twice across a reload race).
    const seen = new Set();
    const deduped = [];
    for (const h of job.rows) {
      const k = (h.caseId || '') + '|' + (h.date || '') + '|' + (h.time || '') + '|' + (h.sittingType || '') + '|' + (h.caseName || '');
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(h);
    }
    state.hearings = deduped;
    state.judgeMeta = { from: job.from, to: job.to, courtName: job.courtName, judgeName: job.judgeName };
    state.judgeCollected = true;
    if (state.els.collect) state.els.collect.style.display = '';
    if (state.els.cancelCollect) state.els.cancelCollect.style.display = 'none';
    if (state.els.total) state.els.total.textContent = deduped.length + ' דיונים';
    if (state.els.count) state.els.count.textContent = deduped.length;
    if (state.els.download) state.els.download.disabled = deduped.length === 0;
    clearJob();
    hideCollectMask();
    setStatus((note ? note + ' ' : '✓ ') + 'האיסוף הסתיים — ' + deduped.length + ' דיונים מ-' +
      job.days.length + ' ימים.');
    // Run the action the user picked (calendar / download / sync) once the whole
    // range is collected — unless the run was cancelled.
    if (job.thenAction && !job._cancelled && deduped.length) runJudgeAction(job.thenAction);
  }

  function judgeCancel() {
    const job = readJob();
    if (!job) { hideCollectMask(); return; }
    job.active = false;
    job._cancelled = true;
    writeJob(job);
    judgeFinish(job, 'האיסוף בוטל.');
  }

  function refreshJudgeReadout() {
    if (!state.els.judge) return;
    const ctx = adapter.judgeContext(document);
    const readout = [ctx.courtName, ctx.judgeName].filter(Boolean).join(' · ') || 'יש לבחור בית משפט ושופט/ת בעמוד';
    state.els.judge.textContent = '⚖️ נבחרו בעמוד: ' + readout;
  }

  // ── download (fan-out to enabled destinations) ──────────────────────
  async function startDownload() {
    if (state.busy) return;
    // Judge mode exports the collected accumulation (no per-row selection);
    // case/user modes export the checkbox selection from the live grid.
    if (state.mode !== 'judge' && state.selected.size === 0) return;
    if (state.mode === 'judge' && !(state.hearings && state.hearings.length)) {
      setStatus('אין דיונים שנאספו עדיין.', 'error'); return;
    }
    if (w.CD && w.CD.getSettings) { state.settings = await w.CD.getSettings(); renderDestChips(); }
    const dests = activeDestinations();
    state.busy = true;
    state.els.download && (state.els.download.disabled = true);

    try {
      // Resolve chosen hearings.
      let chosen;
      if (state.mode === 'judge') {
        chosen = state.hearings.slice();
      } else {
        const all = adapter.listAllHearings(document);
        state.hearings = all;
        chosen = [];
        for (let i = 0; i < all.length; i++) {
          if (state.selected.has(adapter.hearingId(all[i], i))) chosen.push(all[i]);
        }
      }
      if (!chosen.length) { setStatus('לא נמצאו דיונים לייצוא.', 'error'); return; }

      // Naming mirrors the documents feature: single-case exports lead with
      // the case number (e.g. "56708-12-22 - מועדי דיון"); user-calendar
      // exports lead with the date range.
      const nameStem = buildNameStem(chosen);
      const today = new Date().toISOString().slice(0, 10);
      const csvText = buildCsvText(chosen);
      const icsText = CD.buildIcs(chosen, { calName: nameStem });
      const csvBytes = new TextEncoder().encode(csvText).buffer;
      const icsBytes = new TextEncoder().encode(icsText).buffer;
      const csvFileName = sanitize(nameStem, 100) + '.csv';
      const icsFileName = sanitize(nameStem, 100) + '.ics';

      const prof = profile();
      const summary = [];

      // Destination: local ZIP — filename leads with the case number.
      if (dests.localZip) {
        if (!JSZip) {
          summary.push('ZIP ✗ (ספרייה לא נטענה)');
        } else {
          setStatus('בונה ZIP מקומי…');
          const blob = await buildZipBlob(chosen, csvText, icsText, csvFileName, icsFileName);
          saveBlob(blob, sanitize(nameStem, 110) + '_' + today + '.zip');
          summary.push('ZIP ✓ (' + chosen.length + ' דיונים)');
        }
      }

      // Destination: server (hearings profile endpoint/key)
      const serverEp = dests.server && prof.server && prof.server.endpoint;
      const serverKey = (prof.server && prof.server.apiKey) || '';
      let sOk = 0, sFail = 0;
      if (dests.server) {
        if (!serverEp) { summary.push('שרת ✗ (לא הוגדרה כתובת — ⚙)'); }
        else {
          setStatus('מעלה לשרת…');
          const meta = { kind: 'hearings', tag: nameStem, mode: state.mode };
          const r1 = await sendToSW({ type: 'cd/uploadServer', endpoint: serverEp, apiKey: serverKey,
            filename: csvFileName, bytes: csvBytes, mimeType: 'text/csv', meta: meta });
          if (r1 && r1.ok) sOk++; else sFail++;
          const r2 = await sendToSW({ type: 'cd/uploadServer', endpoint: serverEp, apiKey: serverKey,
            filename: icsFileName, bytes: icsBytes, mimeType: 'text/calendar', meta: meta });
          if (r2 && r2.ok) sOk++; else sFail++;
          summary.push('שרת ' + (sFail ? '⚠ ' + sOk + '/' + (sOk + sFail) : '✓ ' + sOk));
        }
      }

      // Destination: Google Drive (hearings profile parent folder)
      if (dests.drive) {
        const parent = (prof.drive && prof.drive.folderId) || '';
        const folderName = nameStem; // e.g. "56708-12-22 - מועדי דיון"
        setStatus('מכין תיקייה ב־Drive: ' + folderName + '…');
        const folderRes = await sendToSW({ type: 'cd/driveEnsureFolder', parentId: parent, name: folderName });
        if (!folderRes || !folderRes.ok || !folderRes.id) {
          summary.push('Drive ✗ (' + ((folderRes && folderRes.error) || 'נכשל').slice(0, 30) + ')');
        } else {
          const folderId = folderRes.id;
          setStatus('מעלה CSV ל־Drive…');
          const r1 = await sendToSW({ type: 'cd/uploadDrive', folderId: folderId, filename: csvFileName, bytes: csvBytes, mimeType: 'text/csv' });
          setStatus('מעלה ICS ל־Drive…');
          const r2 = await sendToSW({ type: 'cd/uploadDrive', folderId: folderId, filename: icsFileName, bytes: icsBytes, mimeType: 'text/calendar' });
          if (r1 && r1.ok && r2 && r2.ok) summary.push('Drive→"' + folderName + '" ✓ 2');
          else summary.push('Drive ⚠ ' + ((r1 && r1.ok ? 1 : 0) + (r2 && r2.ok ? 1 : 0)) + '/2');
        }
      }

      setStatus('✓ הסתיים — ' + chosen.length + ' דיונים · ' + summary.join(' · '));
    } catch (e) {
      setStatus('שגיאה: ' + ((e && e.message) || String(e)), 'error');
    } finally {
      state.busy = false;
      refreshCounts();
    }
  }

  // Container name (ZIP file / Drive folder / server tag). Single-case
  // exports lead with the case number, exactly like the documents feature
  // names its folders ("<caseId> - <listLabel>").
  function buildNameStem(chosen) {
    if (state.mode === 'case') {
      const caseId = caseNumberOf(chosen) || readHeaderCaseId() || 'תיק';
      return caseId + ' - מועדי דיון';
    }
    if (state.mode === 'judge') {
      const m = state.judgeMeta || {};
      const judge = (m.judgeName || 'שופט').replace(/[\\/:*?"<>|]/g, ' ').trim();
      const range = (m.from && m.to)
        ? m.from.replace(/\//g, '-') + ' עד ' + m.to.replace(/\//g, '-')
        : new Date().toISOString().slice(0, 10);
      return 'דיונים לשופט ' + judge + ' - ' + range;
    }
    const from = state.els.from && state.els.from.value.trim();
    const to = state.els.to && state.els.to.value.trim();
    if (from && to) {
      return 'יומן דיונים - ' + from.replace(/\//g, '-') + ' עד ' + to.replace(/\//g, '-');
    }
    return 'יומן דיונים - ' + new Date().toISOString().slice(0, 10);
  }

  // Prefer a populated caseId from the chosen rows (case-mode rows carry the
  // header-derived caseId; some grids also have a per-row case column).
  function caseNumberOf(chosen) {
    for (const h of chosen) if (h && h.caseId) return h.caseId;
    return '';
  }

  // Last-resort: scrape the case number straight from the page header
  // (same regex the adapter uses).
  function readHeaderCaseId() {
    const t = ((document.body && document.body.textContent) || '').slice(0, 6000);
    const m = t.match(/(\d{4,8}-\d{2}-\d{2})/);
    return m ? m[1] : '';
  }

  function buildCsvText(hearings) {
    const rows = hearings.map((h) => adapter.csvRow(h));
    if (w.CD && w.CD.buildCsv) {
      return w.CD.buildCsv(adapter.CSV_HEADERS, rows);
    }
    const BOM = '﻿';
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [adapter.CSV_HEADERS.map(esc).join(',')];
    for (const r of rows) lines.push(adapter.CSV_HEADERS.map((h) => esc(r[h])).join(','));
    return BOM + lines.join('\r\n') + '\r\n';
  }

  async function buildZipBlob(hearings, csvText, icsText, csvFileName, icsFileName) {
    const zip = new JSZip();
    zip.file(csvFileName || 'hearings.csv', csvText);
    zip.file(icsFileName || 'hearings.ics', icsText);
    const sep = zip.folder('per-hearing');
    const usedNames = new Set();
    for (const h of hearings) {
      const base = CD.icsFilename(h);
      let name = base;
      let i = 2;
      while (usedNames.has(name)) {
        name = base.replace(/\.ics$/, '_' + i + '.ics');
        i++;
      }
      usedNames.add(name);
      sep.file(name, CD.buildSingleIcs(h, { calName: 'דיון ' + (h.caseId || '') }));
    }
    return await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────
  function u8ToB64(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function sendToSW(message) {
    // Binary doesn't survive sendMessage (arrives empty → empty uploads). Send
    // it as base64; the service worker decodes it (b64ToU8).
    if (message && (message.bytes instanceof ArrayBuffer || ArrayBuffer.isView(message.bytes))) {
      try { message = Object.assign({}, message, { bytesB64: u8ToB64(message.bytes) }); delete message.bytes; }
      catch (e) { /* fall through */ }
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

  function sanitize(name, maxLen) {
    return String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen || 100);
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 4000);
  }
})();
