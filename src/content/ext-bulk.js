// content/ext-bulk.js — bulk "תיק מקור → תיקי בית משפט" runner.
//
// The popup collects a pasted list of source-case numbers (פל"א by default) and
// hands it here as a job; this script walks the portal's own search screen once
// per number and collects every court case it returns. One source number can
// map to several cases, so each case becomes its own row.
//
// Why a runner and not a background request: the search screen is an ASP.NET
// WebForms page whose two criteria fields are AutoPostBack controls — the server
// builds the query from those round-trips (see content/case-open.js), and
// replaying the sequence out-of-band with fetch() does NOT reproduce it. So the
// tab itself is driven, exactly like the judge-calendar runner does.
//
// Per number that costs two page loads:
//   number → postback · "אישור" → postback · collect + start the next number
// The results never have to be scraped out of the grid's DOM: the page ships the
// whole result set as JSON in a hidden field (CaseSearchResultsGridArrayStore).
//
// Ownership: the job carries a token, and only the tab whose sessionStorage
// holds that token advances it — a second court tab won't fight over the job.
(function (w) {
  const CD = w.CD || (w.CD = {});
  const JOB_KEY = 'cd_bulk_job';        // chrome.storage.local — shared with the popup
  const TOKEN_KEY = 'cd_bulk_token';    // sessionStorage — per tab, marks the runner
  const VEIL_KEY = 'cd_bulk_veil';      // sessionStorage — progress text for the veil
  const STORE_ID = 'CaseSearchResultsGridArrayStore';

  function getJob() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(JOB_KEY, (out) => resolve((out && out[JOB_KEY]) || null));
      } catch (e) { resolve(null); }
    });
  }
  function setJob(job) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [JOB_KEY]: job }, () => resolve(true)); } catch (e) { resolve(false); }
    });
  }
  function isRunner(job) {
    try { return !!job && !!job.token && sessionStorage.getItem(TOKEN_KEY) === job.token; } catch (e) { return false; }
  }
  function veil(text) {
    try {
      if (text) sessionStorage.setItem(VEIL_KEY, text);
      else sessionStorage.removeItem(VEIL_KEY);
    } catch (e) {}
    if (text) { if (CD.extVeilShow) CD.extVeilShow(text); }
    else if (CD.extVeilHide) CD.extVeilHide();
  }
  function progressText(job) {
    return 'מריץ ' + (job.doneCount + 1) + ' מתוך ' + job.total + ' — ' + (job.current || '');
  }

  // The whole result set the site rendered for the current query, straight from
  // its own JSON store — no dependency on the AG-Grid DOM (which only holds the
  // rows currently scrolled into view).
  function scrapeResults() {
    const el = document.getElementById(STORE_ID) || document.querySelector('input[id$="' + STORE_ID + '"]');
    if (!el) return null;
    let arr;
    try { arr = JSON.parse(el.value || '[]'); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    return arr.map((r) => ({
      caseType: r.CaseTypeShortName || '',
      caseNumber: r.CaseDisplayIdentifier || '',
      caseName: r.CaseName || '',
      interest: r.CaseInterestName || '',
      court: r.CourtName || '',
      status: r.CaseStatusName || '',
    })).filter((r) => r.caseNumber);
  }

  async function finish(job, state, error) {
    job.state = state;
    if (error) job.error = error;
    job.current = '';
    await setJob(job);
    veil('');
  }

  // One page load advances the job by exactly ONE action — every action ends in
  // a postback, so once we've acted this document is on its way out and any
  // pending retry must stay out of the way (acting twice would collect the
  // previous page's results or double-submit).
  let acted = false;

  async function step(lastAttempt) {
    const api = CD.extSearchApi;
    if (acted || !api) return;
    const job = await getJob();
    if (!job || job.state !== 'running' || !isRunner(job)) return;
    if (job.at && Date.now() - job.at > 30 * 60000) { await finish(job, 'error', 'ההרצה פגה.'); return; }

    if (!api.onScreen()) {                       // not on the search screen yet
      veil(progressText(job));
      acted = true;
      if (!api.goto()) await finish(job, 'error', 'לא נמצא המסך "תיקים לפי מס\' תיק מקור".');
      return;
    }
    const sel = api.typeSelect(), num = api.numberField(), btn = api.searchButton();
    if (!sel || !num || !btn) return;            // screen still rendering — the retry below covers it

    const want = api.optionValue(sel, job.type);
    if (!want) { await finish(job, 'error', 'סוג תיק המקור אינו קיים ברשימת האתר.'); return; }
    if (!job.current) job.current = job.queue.shift() || '';
    if (!job.current) { await finish(job, 'done'); return; }
    veil(progressText(job));

    // The type, once per run. Capped: if the screen ever came back without our
    // selection we'd otherwise re-post it on every load and never advance.
    if (sel.value !== want && (job.typeTries || 0) < 2) {
      sel.value = want;
      job.typeTries = (job.typeTries || 0) + 1;
      job.at = Date.now();
      acted = true;
      await setJob(job);
      api.press(sel, true);
      return;
    }
    if (job.phase === 'search') {                // criteria are in — run it
      job.phase = 'collect';
      job.at = Date.now();
      acted = true;
      await setJob(job);
      api.press(btn);
      return;
    }
    if (job.phase === 'collect') {               // this page holds the results
      const found = scrapeResults();
      // No store yet → the results are still rendering; let a retry catch it,
      // and only give up on the very last attempt.
      if (found === null && !lastAttempt) return;
      const rows = found || [];
      if (rows.length) rows.forEach((r) => job.rows.push(Object.assign({ source: job.current }, r)));
      else job.rows.push({ source: job.current, caseType: '', caseNumber: '', caseName: '', interest: '', court: '', status: found ? 'לא נמצאו תיקים' : 'לא נקראו תוצאות' });
      job.doneCount += 1;
      job.current = job.queue.shift() || '';
      job.phase = 'number';
      job.at = Date.now();
      if (!job.current) { await finish(job, 'done'); return; }
      await setJob(job);
      veil(progressText(job));
    }
    // phase 'number' — put the next source-case number in and let it post back
    num.value = job.current;
    job.phase = 'search';
    job.at = Date.now();
    acted = true;
    await setJob(job);
    api.press(num, true);
  }

  // The screen can render a beat after document_idle; retry a few times.
  const ATTEMPTS = 6;
  function stepSoon() {
    let n = 0;
    (function attempt() {
      n += 1;
      step(n >= ATTEMPTS);
      if (n < ATTEMPTS && !acted) setTimeout(attempt, 700);
    })();
  }
  // Re-running step() is safe: it re-reads the job and acts on the page's own
  // state, and every branch that acts navigates away.
  let ran = false;
  function boot() {
    if (ran) return;
    ran = true;
    getJob().then((job) => {
      if (job && job.state === 'running' && isRunner(job)) stepSoon();
    });
  }

  // ── the popup starts / stops a run ───────────────────────────────────────
  try {
    if (w.chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, send) => {
        if (!msg) return;
        if (msg.type === 'cd/bulkStart') {
          try { sessionStorage.setItem(TOKEN_KEY, msg.job.token); } catch (e) {
            send({ ok: false, error: 'הדפדפן חוסם אחסון מקומי בלשונית זו.' });
            return true;
          }
          setJob(msg.job).then(() => { send({ ok: true }); stepSoon(); });
          return true;
        }
        if (msg.type === 'cd/bulkStop') {
          getJob().then(async (job) => {
            if (job) await finish(job, 'stopped');
            else veil('');
            send({ ok: true });
          });
          return true;
        }
      });
    }
  } catch (e) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : self);
