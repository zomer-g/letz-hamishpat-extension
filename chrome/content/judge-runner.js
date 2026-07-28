// content/judge-runner.js — collects a judge's docket in a NEW TAB via REAL
// in-page postbacks (form.submit), so it is F5-safe (the security gateway
// rejects fetch-replayed postbacks) and never touches the user's original tab.
//
// The case-page judge button stores a request {judge, court, from, to, action}
// in chrome.storage and opens a new tab at a secured page with #cdjudge=<id>.
// This runner claims that id, then drives a sessionStorage state machine across
// the report's postback reloads:
//   menu   → replay the "דיונים לשופט" menu postback to reach the report form
//   court  → pick the court option (bestOption) and postback (judges populate)
//   judge  → pick the judge option, then submit day 0
//   collect→ harvest each day, submit the next (adapter.submitJudgeReport)
//   done   → CD.openJudgeCalendar(rows, meta)
// Reuses the verified matchers (judgeBg._bestOption/_normCourt/_normJudge) and
// the adapter's report helpers.
(function (w) {
  const CD = w.CD || {};
  if (!/(^|\.)court\.gov\.il$/i.test(location.hostname)) return;

  const RUN_KEY = 'cd_jrun';
  const MAX_DAYS = 92;

  function readRun() { try { return JSON.parse(sessionStorage.getItem(RUN_KEY) || 'null'); } catch (e) { return null; } }
  function writeRun(r) { try { sessionStorage.setItem(RUN_KEY, JSON.stringify(r)); } catch (e) {} }
  function clearRun() { try { sessionStorage.removeItem(RUN_KEY); } catch (e) {} }

  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function parseDMY(s) { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; }
  function fmtDMY(d) { return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function enumerateDays(from, to) {
    const a = parseDMY(from), b = parseDMY(to);
    if (!a || !b || a > b) return null;
    const out = []; const cur = new Date(a.getTime()); let g = 0;
    while (cur <= b && g < 800) { out.push(fmtDMY(cur)); cur.setDate(cur.getDate() + 1); g++; }
    return out.length <= MAX_DAYS ? out : null;
  }

  // Claim a request id from the URL hash on the first load in this tab.
  function claimId() {
    const run = readRun();
    if (run) return Promise.resolve(run);
    const m = location.hash.match(/cdjudge=([\w.-]+)/);
    if (!m) return Promise.resolve(null);
    const id = m[1];
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    const key = 'cd_jreq_' + id;
    return new Promise((res) => {
      try {
        chrome.storage.local.get(key, (d) => {
          const req = d && d[key];
          if (!req) return res(null);
          try { chrome.storage.local.remove(key); } catch (e) {}
          const days = enumerateDays(req.from, req.to);
          if (!days) return res(null);
          const r = { id: id, judge: req.judge, court: req.court, from: req.from, to: req.to,
            action: req.action || 'calview', days: days, collected: 0, rows: [], phase: 'menu' };
          // A fresh run owns this tab — drop leftovers of a previous run.
          try { sessionStorage.removeItem('cd_jdone'); sessionStorage.removeItem('cd_jfail'); } catch (e) {}
          writeRun(r);
          res(r);
        });
      } catch (e) { res(null); }
    });
  }

  // ---- overlay mask (progress) ----
  function mask(msg, frac, err) {
    let el = document.getElementById('cd-jrun-mask');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cd-jrun-mask';
      el.className = 'cd-collect-mask';
      el.dir = 'rtl';
      el.innerHTML = '<div class="cd-collect-mask__card"><div class="cd-collect-mask__title" id="cd-jrun-title">יומן שופט/ת</div>' +
        '<div class="cd-collect-mask__msg" id="cd-jrun-msg"></div>' +
        '<div class="cd-collect-mask__bar"><div class="cd-collect-mask__fill" id="cd-jrun-fill"></div></div></div>';
      (document.body || document.documentElement).appendChild(el);
    }
    const m = document.getElementById('cd-jrun-msg'); if (m) { m.textContent = msg || ''; m.style.color = err ? '#b91c1c' : ''; }
    const f = document.getElementById('cd-jrun-fill'); if (f && frac != null) f.style.width = Math.round(frac * 100) + '%';
  }
  function fail(msg) {
    mask(msg + ' — אפשר לסגור טאב זה.', null, true);
    // Persist the reason: the public portal's grid fires a deferred postback
    // that reloads the page and would wipe the on-screen error — keep a
    // breadcrumb so the failure stays visible (and diagnosable) after it.
    try { sessionStorage.setItem('cd_jfail', msg + ' @' + new Date().toISOString()); } catch (e) {}
    clearRun();
  }

  // ---- real ASP.NET postback (browser sends the whole form → F5-safe) ----
  function theForm() {
    const et = document.querySelector('input[name="__EVENTTARGET"]');
    return (et && et.form) || document.forms[0] || null;
  }
  function realPostback(target, sets) {
    const form = theForm();
    if (!form) return false;
    const et = form.querySelector('input[name="__EVENTTARGET"]'); if (et) et.value = target || '';
    const ea = form.querySelector('input[name="__EVENTARGUMENT"]'); if (ea) ea.value = '';
    (sets || []).forEach((pair) => { if (pair && pair[0]) pair[0].value = pair[1]; });
    try { form.submit(); return true; } catch (e) { return false; }
  }

  function selText(sel) { return sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text.trim() : ''; }
  function selVal(sel) { return sel ? (sel.value || '') : ''; }
  function matches(sel, wanted, normFn, jb) {
    if (!sel) return false;
    const cur = selVal(sel);
    if (!cur || cur === '-1' || cur === '0') return false;
    const opt = jb._bestOption(sel, wanted, normFn);
    return !!(opt && opt.value === cur);
  }

  // Poll until pred() is truthy or the timeout elapses. The report's court/judge
  // combos and its hearings grid populate ASYNCHRONOUSLY after each postback
  // reload, so acting the instant the page loads is what made the runner "get
  // stuck" (empty combos → "court/judge not found") and harvest half-rendered
  // rows. Every phase now awaits the element it needs.
  function waitUntil(pred, timeout, step) {
    timeout = timeout || 8000; step = step || 150;
    return new Promise((res) => {
      let waited = 0;
      (function tick() {
        let ok = false; try { ok = !!pred(); } catch (e) {}
        if (ok) return res(true);
        waited += step;
        if (waited >= timeout) return res(false);
        setTimeout(tick, step);
      })();
    });
  }
  // Count of selectable (non-placeholder) options in a <select>.
  function realOptions(sel) {
    if (!sel || !sel.options) return 0;
    let n = 0;
    for (let i = 0; i < sel.options.length; i++) {
      const v = (sel.options[i].value || '').trim();
      if (v && v !== '-1' && v !== '0') n++;
    }
    return n;
  }
  // A day's report is "ready" once its data is actually present: an embedded
  // ArrayStore (populated OR verified-empty), or rendered AG-Grid rows.
  function dataReady(ad) {
    try {
      if (ad.hasEmptyHearingStore && ad.hasEmptyHearingStore(document)) return true;
      if (ad.listHearingsFromStore) { const s = ad.listHearingsFromStore(document); if (s && s.length) return true; }
      const g = ad.findHearingsGrid && ad.findHearingsGrid(document);
      if (g && g.querySelector('.ag-center-cols-container [role="row"][row-index]')) return true;
    } catch (e) {}
    return false;
  }

  // Prefer the embedded JSON ArrayStore: it holds ALL rows (AG-Grid virtualizes,
  // so the rendered grid only carries the visible slice) and is present in the
  // HTML immediately (no async grid render to wait on). Fall back to the grid.
  function harvest() {
    const ad = CD.adapters && CD.adapters['net-court-hearings'];
    if (!ad) return [];
    try {
      if (ad.listHearingsFromStore) {
        const s = ad.listHearingsFromStore(document);
        if (s && s.length) return s;
      }
    } catch (e) {}
    try { return (ad.listAllHearings && ad.listAllHearings(document)) || []; } catch (e) { return []; }
  }

  // ---- mojibake (◆ / U+FFFD) detection ----
  // Net HaMishpat's server INTERMITTENTLY returns the day-report response with a
  // UTF-8 body while the tab decodes windows-1255 (no <meta charset>, no header)
  // — every Hebrew letter then lands on two undefined 1255 code points and
  // renders as ◆◆. The bytes are gone from the live DOM, and replaying the POST
  // via fetch mid-loop DESYNCS the server's report state (days come back
  // duplicated/shifted — verified live). The safe remedy is to RE-SUBMIT the
  // same day through the normal navigation postback: the corruption is
  // per-response (depends on which server answers), so a retry usually lands on
  // a clean one.
  function hasFFFD(rows) {
    for (const r of rows || []) {
      if (/�/.test((r.caseName || '') + (r.sittingType || '') + (r.proceeding || '') +
        (r.userList || '') + (r.caseId || '') + (r.status || ''))) return true;
    }
    return false;
  }
  // Shared with the in-page report panel (hearings-panel.js), which harvests the
  // same live document day-by-day and is exposed to the same server quirk.
  CD.judgeHasFFFD = hasFFFD;

  // The finished result is kept in sessionStorage so the calendar SURVIVES the
  // report page's own late reload: on the public portal, the grid saves its
  // state via a DEFERRED postback a few seconds after a data render — the last
  // page of the collection lingers, that postback fires, and the reload used to
  // kill the freshly-opened calendar. Any load of this tab re-opens it.
  const DONE_KEY = 'cd_jdone';

  function finish(run) {
    run.phase = 'done';
    // Dedupe (belt-and-suspenders — a day retried across a reload race could
    // land twice). Same signature the panel uses.
    const seen = {};
    run.rows = run.rows.filter((h) => {
      const k = (h.caseId || '') + '|' + (h.date || '') + '|' + (h.time || '') + '|' + (h.sittingType || '') + '|' + (h.caseName || '');
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    writeRun(run);
    mask('נאספו ' + run.rows.length + ' דיונים.', 1);
    const meta = { judgeName: run.judge, courtName: run.court, from: run.from, to: run.to, charset: run.harvestCharset || '' };
    try { sessionStorage.setItem(DONE_KEY, JSON.stringify({ rows: run.rows, meta: meta, ts: Date.now() })); } catch (e) {}
    setTimeout(() => {
      const el = document.getElementById('cd-jrun-mask'); if (el) el.remove();
      if (CD.openJudgeCalendar) CD.openJudgeCalendar(run.rows, meta, {});
    }, 400);
    clearRun();
  }

  // Re-open a finished collection's calendar after the site reloads this tab —
  // or re-show a persisted failure message the reload would otherwise wipe.
  function reopenIfDone() {
    if (readRun()) return false; // an active run owns this tab
    let done = null;
    try { done = JSON.parse(sessionStorage.getItem(DONE_KEY) || 'null'); } catch (e) {}
    if (done && done.rows && CD.openJudgeCalendar) {
      CD.openJudgeCalendar(done.rows, done.meta || {}, {});
      return true;
    }
    let failMsg = '';
    try { failMsg = sessionStorage.getItem('cd_jfail') || ''; } catch (e) {}
    if (failMsg) { mask(failMsg.replace(/ @.*$/, '') + ' — אפשר לסגור טאב זה.', null, true); return true; }
    return false;
  }

  async function drive() {
    const run = await claimId();
    if (!run || run.phase === 'done') return;
    const ad = CD.adapters && CD.adapters['net-court-hearings'];
    const jb = CD.judgeBg;
    if (!ad || !jb || !jb._bestOption) return;

    // Phase: reach the report form via the menu postback. Give a slow-loading
    // report form a moment to appear before concluding we're NOT on it.
    let courtSel = ad.findCourtSelect(document);
    let reportBtn = ad.findReportButton && ad.findReportButton(document);
    if (!(courtSel && reportBtn)) {
      await waitUntil(() => ad.findCourtSelect(document) && ad.findReportButton(document), 4000);
      courtSel = ad.findCourtSelect(document);
      reportBtn = ad.findReportButton && ad.findReportButton(document);
    }
    if (!(courtSel && reportBtn)) {
      const menu = document.querySelector('[id*="btnJudgeDiscussion" i]');
      const t = menu && ((menu.getAttribute('href') || '') + ' ' + (menu.getAttribute('onclick') || '')).match(/__doPostBack\('([^']+)'/);
      if (t) { mask('פותח את דוח השופט/ת…', 0.1); realPostback(t[1], []); }
      else fail('לא נמצא הקישור לדוח "דיונים לשופט"');
      return;
    }

    // Phase: choose the court (cascade → judges populate on reload). Wait for the
    // court combo to actually carry options — an empty combo is why the run used
    // to fail with "court not found ברשימת הדוח" on a slow load.
    await waitUntil(() => realOptions(ad.findCourtSelect(document)) >= 1, 8000);
    courtSel = ad.findCourtSelect(document);
    if (!matches(courtSel, run.court, jb._normCourt, jb)) {
      const opt = jb._bestOption(courtSel, run.court, jb._normCourt);
      if (!opt) { fail('בית המשפט "' + run.court + '" לא נמצא ברשימת הדוח'); return; }
      mask('בוחר בית משפט: ' + opt.text + '…', 0.25);
      realPostback(courtSel.name, [[courtSel, opt.value]]);
      return;
    }

    // Phase: choose the judge. The judge combo is populated ASYNCHRONOUSLY for
    // the chosen court, so wait for it to fill before matching (otherwise the run
    // stalls at "judge not found").
    await waitUntil(() => realOptions(ad.findJudgeSelect(document)) >= 1, 12000);
    const judgeSel = ad.findJudgeSelect(document);
    if (!matches(judgeSel, run.judge, jb._normJudge, jb)) {
      const opt = judgeSel && jb._bestOption(judgeSel, run.judge, jb._normJudge);
      if (!opt) {
        // Session-state skew: a fresh report page can render the court as
        // ALREADY selected (server session) while the judge list still belongs
        // to another court — the judge is then "missing". Re-fire the court
        // cascade postback to repopulate the list, and only fail after retries.
        run.uiRetries = run.uiRetries || {};
        const tries = run.uiRetries.judge || 0;
        if (tries < 2 && courtSel && courtSel.name) {
          run.uiRetries.judge = tries + 1;
          writeRun(run);
          mask('מרענן את רשימת השופטים (' + (tries + 1) + '/2)…', 0.3);
          realPostback(courtSel.name, [[courtSel, courtSel.value]]);
          return;
        }
        fail('השופט/ת "' + run.judge + '" לא נמצאו בבית המשפט שנבחר');
        return;
      }
      if (judgeSel) judgeSel.value = opt.value;
      run.judgeText = opt.text;
      writeRun(run);
      // proceed straight to collecting day 0 (submit carries the selected judge)
    }

    // Phase: collect day-by-day via real navigation. If we just returned from a
    // day submit, wait for the day's data to render, then harvest the ArrayStore.
    if (run._submitted) {
      // Rendered-day verification: the site's WAF intermittently blocks rapid
      // successive postbacks ("חסימת בקשה לא מורשת" / a bounce re-rendering the
      // previous report). Only a page whose date field round-tripped OUR day is
      // this day's report — anything else must be re-submitted, not harvested
      // (harvesting it is what duplicated/lost days).
      const expectDay = run.days[run.collected];
      const dEl = ad.findSingleDateInput && ad.findSingleDateInput(document);
      if (!dEl || (dEl.value || '').trim() !== expectDay) {
        run.dayRetries = run.dayRetries || {};
        const tries = run.dayRetries[expectDay] || 0;
        if (tries < 3) {
          run.dayRetries[expectDay] = tries + 1;
          writeRun(run); // _submitted stays true → next load re-verifies
          mask('העמוד אינו מציג את ' + expectDay + ' — מגיש שוב (' + (tries + 1) + '/3)…',
            0.3 + 0.6 * (run.collected / run.days.length));
          await new Promise((r) => setTimeout(r, 1800 * (tries + 1))); // WAF backoff
          if (ad.submitJudgeReport && ad.submitJudgeReport(document, expectDay)) return;
        }
        fail('האתר חסם את רצף הבקשות ביום ' + expectDay + ' — נסה/י שוב עם טווח קצר יותר');
        return;
      }

      await waitUntil(() => dataReady(ad), 8000);
      // Record how THIS collection tab decoded the report. If Hebrew comes back
      // as ◆ (U+FFFD), it means the tab decoded windows-1255 bytes as the wrong
      // charset — capture it so the calendar can surface the exact cause.
      if (!run.harvestCharset) run.harvestCharset = document.characterSet;
      let rows = harvest();
      // Mojibake retry: the server sometimes returns this day's response with a
      // UTF-8 body that the tab decoded as windows-1255 (all Hebrew → ◆). The
      // corruption is per-response, so RE-SUBMIT the same day via the normal
      // postback (up to 2 retries) — never fetch-replay, which desyncs the
      // server's report state and shifts/duplicates days.
      if (hasFFFD(rows)) {
        const day = run.days[run.collected];
        run.badDays = run.badDays || {};
        const tries = run.badDays[day] || 0;
        if (tries < 2 && ad.submitJudgeReport) {
          run.badDays[day] = tries + 1;
          writeRun(run); // keep _submitted=true → next load re-harvests this day
          mask('קידוד פגום ביום ' + day + ' — מנסה שוב (' + (tries + 1) + '/2)…',
            0.3 + 0.6 * (run.collected / run.days.length));
          if (ad.submitJudgeReport(document, day)) return;
        }
        // Retries exhausted (or submit failed) — keep the rows; the calendar
        // shows the ⚠ קידוד badge so the user knows this day's text is corrupt.
        run.harvestCharset = document.characterSet + ' ◆';
      }
      // The report rows carry NO date field (StartTime is just "HH:MM") — the
      // hearing's date is implied by the day we submitted. Stamp it, otherwise
      // the calendar (which groups by h.date) drops every row.
      const curDay = run.days[run.collected];
      rows.forEach((h) => { if (!h.date) h.date = curDay; });
      rows.forEach((h) => run.rows.push(h));
      run.collected += 1;
      run._submitted = false;
      writeRun(run);
    }
    if (run.collected >= run.days.length) { finish(run); return; }

    const day = run.days[run.collected];
    mask('אוסף יום ' + (run.collected + 1) + '/' + run.days.length + ' (' + day + ') · ' + run.rows.length + ' דיונים…',
      0.3 + 0.6 * (run.collected / run.days.length));
    run._submitted = true;
    writeRun(run);
    // Pace the loop — back-to-back postbacks trip the site's WAF (see the
    // rendered-day verification above), which is what corrupted collections.
    await new Promise((r) => setTimeout(r, 1200));
    if (!ad.submitJudgeReport || !ad.submitJudgeReport(document, day)) {
      fail('לא הצלחתי להפעיל את הדוח ליום ' + day);
    }
  }

  // Cache the report's OWN court list (…ComboBoxCourt, not the header locator's
  // PreviousCourt) so the judge popover can offer a CLOSED list of courts based
  // on the real report — guaranteeing the pick will match on collection.
  function cacheCourts() {
    try {
      const sels = Array.prototype.slice.call(document.querySelectorAll('select'))
        .filter((s) => /ComboBoxCourt/i.test(s.id || '') && !/Previous|CaseLocatorHeader/i.test(s.id || ''));
      const cs = sels[0];
      if (!cs || cs.options.length < 5) return;
      const list = Array.prototype.map.call(cs.options, (o) => (o.text || '').trim())
        .filter((t) => t && t.length > 2 && !/^-+$|בחר|בחירה/.test(t));
      if (list.length >= 5 && w.chrome && chrome.storage) chrome.storage.local.set({ cd_courtList: list });
    } catch (e) {}
  }

  function boot() {
    // Build marker — readable from the page as documentElement[data-cd-runner].
    // Lets us verify WHICH judge-runner build is actually injected (the manifest
    // version alone proved insufficient: a stale-loaded runner once shipped
    // under a fresh manifest). Bump the tag when this file changes materially.
    try { document.documentElement.setAttribute('data-cd-runner', 'r34'); } catch (e) {}
    cacheCourts();
    if (!reopenIfDone()) drive();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : self);
