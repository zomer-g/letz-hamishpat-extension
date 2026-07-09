// Tests for the background judge-report collector (content/judge-bg-collector.js)
// and the case-page judge chip (content/case-judge-chip.js): fetch-replayed
// postbacks, __VIEWSTATE carry-over, verified/unverified empty-day handling,
// cancellation, the cascading court→judge combo flow, and honorific-tolerant
// name matching.

const { loadScripts } = require('./helpers/env.js');
const {
  judgeReportPage, judgeReportResultPage, judgeReportLandingPage, casePage,
  JUDGE_REPORT_URL, CASE_PAGE_URL,
} = require('./fixtures/hearings-fixtures.js');

const BG_SCRIPTS = ['content/adapters/net-court-hearings.js', 'content/judge-bg-collector.js'];

// Install a scripted fetch on the jsdom window: each call shifts the next
// handler {html} (or {error}) off the queue and records {url, method, body}.
function mockFetch(w, queue) {
  const requests = [];
  w.fetch = async function (url, opts) {
    opts = opts || {};
    requests.push({ url: String(url), method: opts.method || 'GET', body: opts.body || '' });
    const next = queue.shift();
    if (!next) throw new Error('fetch queue exhausted for ' + url);
    if (next.error) throw new Error(next.error);
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status || 200,
      url: next.url || String(url),
      text: async () => next.html || '',
    };
  };
  return requests;
}

// A raw ArrayStore row shaped like the real report grid data.
function storeRow(over) {
  return Object.assign({
    StartTime: '2026-06-01T10:30:00',
    CaseDisplayIdentifier: '12345-06-26',
    ProceedingName: 'תביעה אזרחית',
    CaseName: "פלוני נ' אלמוני",
    SittingTypeName: 'קדם משפט',
    UserList: 'כהן דנה',
    SittingActivityStatusName: 'מתוכנן',
  }, over || {});
}

async function run(t) {
  t.section('judge-bg: collectRange collects a range without touching the page');
  {
    const env = loadScripts(judgeReportPage(), { url: JUDGE_REPORT_URL, scripts: BG_SCRIPTS });
    const w = env.window;
    const requests = mockFetch(w, [
      { html: judgeReportResultPage({ rows: [storeRow(), storeRow({ StartTime: '2026-06-01T12:00:00' })], viewState: 'vs-day1' }) },
      { html: judgeReportResultPage({ rows: [], viewState: 'vs-day2' }) },
    ]);
    const progress = [];
    const res = await w.CD.judgeBg.collectRange({
      seedDoc: w.document, seedUrl: JUDGE_REPORT_URL,
      days: ['01/06/2026', '02/06/2026'],
      onProgress: (d, n, c) => progress.push([d, n, c]),
    });
    t.ok('ok result', res.ok === true);
    t.eq('collected hearings', res.hearings.length, 2);
    t.eq('both days verified', res.verifiedDays, 2);
    t.eq('no unverified days', res.unverifiedDays, 0);
    t.eq('hearing date parsed from the store', res.hearings[0].date, '01/06/2026');
    t.eq('hearing time parsed from the store', res.hearings[0].time, '10:30');
    t.eq('two report postbacks', requests.length, 2);
    t.ok('day-1 posts to the form action',
      requests[0].url.indexOf('/Ngcs.Web.Secured/Calendar/CalendarSittingJudge.aspx') !== -1);
    t.ok('day-1 body targets the report button',
      requests[0].body.indexOf('__EVENTTARGET=' + encodeURIComponent('_ctl2:makeReportUIButton')) !== -1);
    t.ok('day-1 body carries the date',
      requests[0].body.indexOf(encodeURIComponent('_ctl2:NGCSWebCalendarFromDate') + '=' + encodeURIComponent('01/06/2026')) !== -1);
    t.ok('day-1 body carries the seed __VIEWSTATE',
      requests[0].body.indexOf('__VIEWSTATE=vs-token') !== -1);
    t.ok('day-2 body carries day-1 response __VIEWSTATE (carry-over)',
      requests[1].body.indexOf('__VIEWSTATE=vs-day1') !== -1);
    t.ok('day-2 body carries the second date',
      requests[1].body.indexOf(encodeURIComponent('02/06/2026')) !== -1);
    t.ok('progress reported', progress.length >= 3);
    t.deepEq('final progress is complete', progress[progress.length - 1], [2, 2, 2]);
  }

  t.section('judge-bg: a range of ONLY unverifiable empties refuses (fallback signal)');
  {
    const env = loadScripts(judgeReportPage(), { url: JUDGE_REPORT_URL, scripts: BG_SCRIPTS });
    const w = env.window;
    mockFetch(w, [
      { html: judgeReportResultPage({ noStore: true }) },
      { html: judgeReportResultPage({ noStore: true }) },
    ]);
    const res = await w.CD.judgeBg.collectRange({
      seedDoc: w.document, seedUrl: JUDGE_REPORT_URL, days: ['01/06/2026', '02/06/2026'],
    });
    t.ok('not ok', res.ok === false);
    t.eq('unverified-empty error', res.error, 'unverified-empty');
    t.eq('no hearings reported', res.hearings.length, 0);
  }

  t.section('judge-bg: a verified store legitimizes unverifiable empty days');
  {
    const env = loadScripts(judgeReportPage(), { url: JUDGE_REPORT_URL, scripts: BG_SCRIPTS });
    const w = env.window;
    mockFetch(w, [
      { html: judgeReportResultPage({ rows: [storeRow()] }) },
      { html: judgeReportResultPage({ noStore: true }) },
    ]);
    const res = await w.CD.judgeBg.collectRange({
      seedDoc: w.document, seedUrl: JUDGE_REPORT_URL, days: ['01/06/2026', '02/06/2026'],
    });
    t.ok('ok result', res.ok === true);
    t.eq('one hearing', res.hearings.length, 1);
    t.eq('one verified day', res.verifiedDays, 1);
    t.eq('one unverified day', res.unverifiedDays, 1);
  }

  t.section('judge-bg: cancellation stops between days');
  {
    const env = loadScripts(judgeReportPage(), { url: JUDGE_REPORT_URL, scripts: BG_SCRIPTS });
    const w = env.window;
    const requests = mockFetch(w, [
      { html: judgeReportResultPage({ rows: [storeRow()] }) },
      { html: judgeReportResultPage({ rows: [storeRow()] }) },
      { html: judgeReportResultPage({ rows: [storeRow()] }) },
    ]);
    const token = { cancelled: false };
    const res = await w.CD.judgeBg.collectRange({
      seedDoc: w.document, seedUrl: JUDGE_REPORT_URL,
      days: ['01/06/2026', '02/06/2026', '03/06/2026'], token: token,
      onProgress: (d) => { if (d === 1) token.cancelled = true; },
    });
    t.ok('cancelled result', res.cancelled === true);
    t.eq('only day 1 was fetched', requests.length, 1);
    t.eq('day-1 rows retained', res.hearings.length, 1);
  }

  t.section('judge-bg: fetch failure aborts cleanly');
  {
    const env = loadScripts(judgeReportPage(), { url: JUDGE_REPORT_URL, scripts: BG_SCRIPTS });
    const w = env.window;
    mockFetch(w, [{ error: 'network down' }]);
    const res = await w.CD.judgeBg.collectRange({
      seedDoc: w.document, seedUrl: JUDGE_REPORT_URL, days: ['01/06/2026'],
    });
    t.ok('not ok', res.ok === false);
    t.eq('fetch-failed error', res.error, 'fetch-failed');
  }

  t.section('judge-bg: collectFromCase resolves the cascaded court → judge combos');
  {
    const env = loadScripts(casePage(), { url: CASE_PAGE_URL, scripts: BG_SCRIPTS });
    const w = env.window;
    const requests = mockFetch(w, [
      // 1) GET the report page — judge combo still empty (cascaded).
      { html: judgeReportLandingPage() },
      // 2) POST the court-change postback — judges now listed.
      { html: judgeReportResultPage({ judges: [{ value: 'J7', text: 'כהן דנה' }, { value: 'J8', text: 'לוי יוסף' }], noStore: true }) },
      // 3) POST day 1 — hearings store present.
      { html: judgeReportResultPage({ rows: [storeRow()], viewState: 'vs-day1' }) },
    ]);
    const res = await w.CD.judgeBg.collectFromCase({
      judgeName: 'כבוד השופטת דנה כהן',
      courtName: 'בית משפט השלום בתל אביב',
      days: ['01/06/2026'],
      baseDoc: w.document, baseUrl: CASE_PAGE_URL,
    });
    t.ok('ok result', res.ok === true);
    t.eq('one hearing collected', res.hearings.length, 1);
    t.eq('resolved judge option text', res.judgeName, 'כהן דנה');
    t.eq('resolved court option text', res.courtName, 'בית משפט השלום בתל אביב');
    t.eq('three requests (GET + court postback + day report)', requests.length, 3);
    t.eq('first request is a GET', requests[0].method, 'GET');
    t.ok('GET went to the secured report page',
      requests[0].url.indexOf('/Ngcs.Web.Secured/Calendar/CalendarSittingJudge.aspx') !== -1);
    t.ok('court postback targets the court combo',
      requests[1].body.indexOf('__EVENTTARGET=' + encodeURIComponent('_ctl2$NGCSWebComboBoxCourt')) !== -1);
    t.ok('court postback carries the matched court value',
      requests[1].body.indexOf(encodeURIComponent('_ctl2$NGCSWebComboBoxCourt') + '=C1') !== -1);
    t.ok('day report carries the matched judge value',
      requests[2].body.indexOf(encodeURIComponent('_ctl2$NGCSWebComboBoxJudge') + '=J7') !== -1);
    t.ok('day report carries the date',
      requests[2].body.indexOf(encodeURIComponent('01/06/2026')) !== -1);
  }

  t.section('judge-bg: judge-not-found is reported (no silent empty result)');
  {
    const env = loadScripts(casePage({ judge: 'כבוד השופט ישראל ישראלי' }), { url: CASE_PAGE_URL, scripts: BG_SCRIPTS });
    const w = env.window;
    mockFetch(w, [
      { html: judgeReportLandingPage() },
      { html: judgeReportResultPage({ judges: [{ value: 'J7', text: 'כהן דנה' }], noStore: true }) },
    ]);
    const res = await w.CD.judgeBg.collectFromCase({
      judgeName: 'כבוד השופט ישראל ישראלי',
      courtName: 'בית משפט השלום בתל אביב',
      days: ['01/06/2026'],
      baseDoc: w.document, baseUrl: CASE_PAGE_URL,
    });
    t.ok('not ok', res.ok === false);
    t.eq('judge-not-found error', res.error, 'judge-not-found');
  }

  t.section('judge-bg: name normalization/matching');
  {
    const env = loadScripts('<!DOCTYPE html><html><body></body></html>', { url: CASE_PAGE_URL, scripts: BG_SCRIPTS });
    const bg = env.window.CD.judgeBg;
    t.eq('honorifics stripped', bg._normJudge('בפני כבוד השופטת הבכירה דנה כהן'), 'דנה כהן');
    t.eq('registrar title stripped', bg._normJudge("כב' הרשם יוסי לוי"), 'יוסי לוי');
    t.eq('court normalization equates בית משפט/ביהמ"ש', bg._normCourt('ביהמ"ש השלום בתל אביב'), bg._normCourt('בית משפט השלום בתל אביב'));

    // bestOption: order-free token match, ambiguity → null.
    const doc = new env.window.DOMParser().parseFromString(
      '<select><option value="">בחר</option>' +
      '<option value="J1">כהן דנה</option>' +
      '<option value="J2">לוי יוסף</option></select>', 'text/html');
    const sel = doc.querySelector('select');
    const opt = bg._bestOption(sel, 'כבוד השופטת דנה כהן', bg._normJudge);
    t.ok('order-free match found', !!opt && opt.value === 'J1');
    const none = bg._bestOption(sel, 'כבוד השופט אבי מזרחי', bg._normJudge);
    t.ok('no match → null', none === null);
  }

  t.section('hearings-adapter: findCourtSelect picks the report combo, not the header locator');
  {
    const html = '<!DOCTYPE html><html><body>' +
      // The header case-locator court (earlier in the DOM) must be IGNORED.
      '<select id="_ctl0_Header_CaseLocatorHeaderUC2_PreviousCourtComboBoxHT"><option value="9">משפחה פתח תקווה</option></select>' +
      // The report\'s OWN court combo must be chosen.
      '<select id="_ctl2_NGCSWebComboBoxCourt"><option value="5">שלום פתח תקווה</option></select>' +
      '</body></html>';
    const env = loadScripts(html, { url: CASE_PAGE_URL, scripts: ['content/adapters/net-court-hearings.js'] });
    const ad = env.CD.adapters['net-court-hearings'];
    const sel = ad.findCourtSelect(env.window.document);
    t.ok('a court select is found', !!sel);
    t.ok('it is the report combo (ComboBoxCourt), not PreviousCourtComboBoxHT', !!(sel && /NGCSWebComboBoxCourt/.test(sel.id)));
  }

  t.section('judge-bg: court match tolerates the Hebrew locative "ב" prefix (בפתח vs פתח)');
  {
    const env = loadScripts('<!DOCTYPE html><html><body></body></html>', { url: CASE_PAGE_URL, scripts: BG_SCRIPTS });
    const CD = env.CD, d = env.window.document;
    const sel = d.createElement('select');
    // Real report-dropdown texts (from CalendarSittingJudge): the court is
    // "שלום פתח תקווה" while the case banner says "בית משפט השלום בפתח תקווה".
    [['', '-1'], ['שלום פתח תקווה', '5'], ['עניינים מקומיים פתח תקווה', '8'], ['שלום תל אביב', '6'], ['המחוזי מרכז', '7']]
      .forEach(([txt, val]) => { const o = d.createElement('option'); o.text = txt; o.value = val; sel.appendChild(o); });
    const opt = CD.judgeBg._bestOption(sel, 'בית משפט השלום בפתח תקווה', CD.judgeBg._normCourt);
    t.ok('matches the court despite the ב-prefix + "בית משפט" gap', !!opt);
    t.eq('picks the שלום פתח תקווה option', opt && opt.value, '5');
    const other = CD.judgeBg._bestOption(sel, 'בית משפט השלום בחיפה', CD.judgeBg._normCourt);
    t.eq('no false match for a city not in the list', other, null);
  }

  t.section('case-judge-chip: chip mounts next to the judge name and opens the popover');
  {
    const env = loadScripts(casePage(), {
      url: CASE_PAGE_URL,
      scripts: BG_SCRIPTS.concat(['content/judge-calendar.js', 'content/case-judge-chip.js']),
    });
    const w = env.window;
    // The chip mounts on a 500ms bootstrap tick.
    await new Promise((r) => setTimeout(r, 700));
    const chip = w.document.getElementById('cd-judge-chip');
    t.ok('chip injected', !!chip);
    t.ok('chip sits inside the judge cell', !!(chip && chip.closest('#JudgeNameCell')));
    if (chip) {
      chip.click();
      const pop = w.document.getElementById('cd-jpop');
      t.ok('popover opens', !!pop);
      t.ok('popover names the judge', !!(pop && pop.textContent.indexOf('דנה כהן') !== -1));
      t.ok('popover shows the court', !!(pop && pop.textContent.indexOf('בית משפט השלום בתל אביב') !== -1));
      t.ok('has from/to inputs', !!(pop && pop.querySelector('[data-jp="from"]') && pop.querySelector('[data-jp="to"]')));
    }
  }

  t.section('case-judge-chip: findJudge ignores nav menus and reads the real judge column');
  {
    const html = '<!DOCTYPE html><html><body>' +
      '<div class="dropdown-menu"><a id="_ctl0_Header_UpperMenu1_btnJudgeDiscussion" class="dropdown-item">דיונים לשופט ליום דיונים</a></div>' +
      '<div class="ag-center-cols-container"><div role="row"><div role="gridcell" col-id="DecisionSignatureUserName">מיכל בר</div></div></div>' +
      '<div>בית משפט השלום בפתח תקווה</div>' +
      '</body></html>';
    const env = loadScripts(html, {
      url: CASE_PAGE_URL,
      scripts: BG_SCRIPTS.concat(['content/judge-calendar.js', 'content/case-judge-chip.js']),
    });
    const w = env.window;
    await new Promise((r) => setTimeout(r, 700));
    const chip = w.document.getElementById('cd-judge-chip');
    t.ok('chip injected', !!chip);
    t.ok('chip attached to the judge column, not the nav menu', !!(chip && chip.closest('[col-id="DecisionSignatureUserName"]')));
    if (chip) {
      chip.click();
      const pop = w.document.getElementById('cd-jpop');
      t.ok('popover names the REAL judge (מיכל בר)', !!(pop && /מיכל בר/.test(pop.textContent)));
      t.ok('popover does NOT read the nav item as a judge', !(pop && /דיונים לשופט ליום דיונים/.test(pop.textContent)));
    }
  }

  t.section('case-judge-chip: floating mode mounts a COMPACT button that opens the popover (dual-config)');
  {
    const env = loadScripts(casePage(), {
      url: CASE_PAGE_URL,
      store: { cd_settings: { ui: { floating: true } } },
      scripts: ['shared/settings.js', 'shared/ui-host.js']
        .concat(BG_SCRIPTS).concat(['content/judge-calendar.js', 'content/case-judge-chip.js']),
    });
    const w = env.window;
    await new Promise((r) => setTimeout(r, 900));
    t.ok('no inline chip in floating mode', !w.document.getElementById('cd-judge-chip'));
    const jf = w.document.getElementById('cd-jfloat');
    t.ok('floating judge button mounted', !!jf);
    t.ok('button lives inside the float window', !!(jf && jf.closest('#cd-float')));
    const btn = jf && jf.querySelector('.cd-jfb');
    t.ok('it is a compact button (not a full panel)', !!btn);
    t.ok('button names the judge', !!(jf && jf.textContent.indexOf('דנה כהן') !== -1));
    if (btn) {
      btn.click();
      const pop = w.document.getElementById('cd-jpop');
      t.ok('clicking opens the popover with range + calview', !!(pop &&
        pop.querySelector('[data-jp="from"]') && pop.querySelector('[data-jp="to"]') && pop.querySelector('[data-jp="calview"]')));
    }
  }

  t.section('judge-calendar: תצוגת יומן opens even with ZERO hearings (the silent no-op bug)');
  {
    const env = loadScripts('<!DOCTYPE html><html><body></body></html>', {
      url: CASE_PAGE_URL, scripts: ['content/judge-calendar.js'],
    });
    const w = env.window, CD = env.CD;
    t.ok('openJudgeCalendar exposed', typeof CD.openJudgeCalendar === 'function');
    // Zero hearings for the range → must still show the (empty) calendar.
    CD.openJudgeCalendar([], { judgeName: 'דנה כהן', courtName: 'בית משפט השלום בתל אביב', from: '01/08/2026', to: '10/08/2026' }, {});
    const ov = w.document.querySelector('.cd-jcal-overlay');
    t.ok('empty calendar overlay opens (not a silent no-op)', !!ov);
    t.ok('empty state shows 0 count', !!(ov && /0 דיונים/.test(ov.textContent)));
    t.ok('empty state names the judge', !!(ov && ov.textContent.indexOf('דנה כהן') !== -1));

    CD.closeJudgeCalendar();
    t.ok('closes cleanly', !w.document.querySelector('.cd-jcal-overlay'));

    CD.openJudgeCalendar(
      [{ date: '05/08/2026', time: '09:00', caseId: 'תא 111-01-25', caseName: "א' נ' ב'", sittingType: 'תזכורת' }],
      { judgeName: 'דנה כהן', from: '01/08/2026', to: '10/08/2026' }, {});
    const ov2 = w.document.querySelector('.cd-jcal-overlay');
    t.ok('non-empty calendar opens', !!ov2);
    t.ok('shows 1 count', !!(ov2 && /1 דיונים/.test(ov2.textContent)));
  }
}

module.exports = { run };
