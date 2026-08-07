// Tests for the popup's "תיקי מקור" tab (popup/popup.html + popup.js) — the
// surface where a pasted list of source-case numbers turns into a job for the
// in-page runner (content/ext-bulk.js) and, when it reports back, a table.
//
// The whole popup is loaded, not a hand-rolled fragment, so the tab wiring and
// the element ids are covered too.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { EXT_ROOT, readScript, makeChrome } = require('./helpers/env.js');

function loadPopup(store, replies) {
  const html = fs.readFileSync(path.join(EXT_ROOT, 'popup', 'popup.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/popup/popup.html', runScripts: 'outside-only' });
  const w = dom.window;
  const sent = [];
  w.chrome = makeChrome(store || {});
  w.chrome.tabs = {
    query: (_q, cb) => cb([{ id: 7, url: 'https://www.court.gov.il/NGCS.Web.Site/HomePage.aspx' }]),
    sendMessage: (tabId, msg, cb) => { sent.push({ tabId, msg }); if (cb) cb({ ok: true }); },
    create: () => {},
  };
  w.chrome.runtime.sendMessage = (m, cb) => {
    const r = replies && replies[m && m.type];
    if (cb) cb(r !== undefined ? r : { ok: true });
  };
  ['shared/settings.js', 'shared/case-locator.js', 'shared/csv.js', 'popup/popup.js']
    .forEach((rel) => w.eval(readScript(rel)));
  return { w, d: w.document, sent, store: store || {} };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function run(t) {
  // Reloading the calendar list must not move the user's pick. It used to reset
  // the <select> to the SAVED id, so choosing a calendar (or creating one) and
  // then pressing "התחבר וטען יומנים" again silently jumped back to the old
  // target — and a sync that looked configured went to the wrong calendar.
  t.section('popup: reloading calendars keeps the calendar you picked');
  {
    const CALS = [
      { id: 'old@group.calendar.google.com', summary: 'zomer- bugaton' },
      { id: 'test@group.calendar.google.com', summary: 'בדיקת לץ המשפט' },
    ];
    const { w, d } = loadPopup(
      { settings: { calendarSync: { calendarId: 'old@group.calendar.google.com', calendarName: 'zomer- bugaton' } } },
      { 'cd/calConnect': { ok: true, email: 'x@y.z' }, 'cd/calListCalendars': { ok: true, calendars: CALS } });
    await tick();

    const sel = d.getElementById('cal-select');
    d.getElementById('cal-connect').click();
    await tick(); await tick();
    t.eq('saved calendar is selected on first load', sel.value, 'old@group.calendar.google.com');

    // The user picks the other calendar but has NOT pressed save yet.
    sel.value = 'test@group.calendar.google.com';

    // …then presses "התחבר וטען יומנים" again.
    d.getElementById('cal-connect').click();
    await tick(); await tick();
    t.eq('the pick survives a reload', sel.value, 'test@group.calendar.google.com');
    t.eq('list still complete', sel.options.length, 2);
  }

  t.section('popup: the "תיקי מקור" tab exists and owns its own view');
  {
    const { d } = loadPopup();
    const tab = d.getElementById('tab-bulk');
    const view = d.getElementById('pu-view-bulk');
    t.ok('tab button present', !!tab);
    t.ok('view present', !!view);
    t.eq('view starts hidden', view.hidden, true);
    tab.dispatchEvent(new d.defaultView.Event('click'));
    t.eq('clicking the tab shows it', view.hidden, false);
    t.eq('and hides the profile view', d.getElementById('pu-view-profile').hidden, true);
    t.ok('the tab is marked active', tab.className.indexOf('pu-tab--active') >= 0);
  }

  t.section('popup: the type list is the closed source-case list, defaulting to פל"א');
  {
    const { d, w } = loadPopup();
    const sel = d.getElementById('bulk-type');
    t.eq('one option per type', sel.options.length, w.CD.EXTERNAL_CASE_TYPES.length);
    t.eq('defaults to תיק משטרתי (פל"א)', sel.value, '2');
  }

  t.section('popup: a pasted list becomes a job for the active court tab');
  {
    const { d, sent } = loadPopup();
    d.getElementById('bulk-input').value = '68480/2024\n132178/2023\n\n68480/2024, 55/2020';
    d.getElementById('bulk-run').dispatchEvent(new d.defaultView.Event('click'));
    await tick();
    t.eq('one message sent', sent.length, 1);
    t.eq('to the active tab', sent[0].tabId, 7);
    t.eq('as a bulk start', sent[0].msg.type, 'cd/bulkStart');
    const job = sent[0].msg.job;
    t.eq('3 unique numbers (blank and duplicate dropped)', job.total, 3);
    t.eq('first is current', job.current, '68480/2024');
    t.deepEq('the rest are queued', job.queue, ['132178/2023', '55/2020']);
    t.eq('type carried', job.type, '2');
    t.eq('starts running', job.state, 'running');
    t.ok('carries an ownership token', !!job.token);
  }

  t.section('popup: nothing to run is reported, not sent');
  {
    const { d, sent } = loadPopup();
    d.getElementById('bulk-input').value = '   \n  ';
    d.getElementById('bulk-run').dispatchEvent(new d.defaultView.Event('click'));
    await tick();
    t.eq('no message', sent.length, 0);
    t.ok('the user is told', /מספר תיק מקור/.test(d.getElementById('bulk-status').textContent));
  }

  t.section('popup: results already in storage are rendered as a table');
  {
    const { d } = loadPopup({
      cd_bulk_job: {
        token: 'x', type: '2', queue: [], current: '', phase: 'number', total: 2, doneCount: 2,
        state: 'done',
        rows: [
          { source: '68480/2024', caseType: 'ת"פ', caseNumber: '56226-02-24', court: 'שלום ירושלים', status: 'סגור' },
          { source: '68480/2024', caseType: 'מ"ת', caseNumber: '56259-02-24', court: 'שלום ירושלים', status: 'סגור' },
          { source: '55/2020', caseType: '', caseNumber: '', court: '', status: 'לא נמצאו תיקים' },
        ],
      },
    });
    await tick();
    const rows = d.querySelectorAll('#bulk-table tbody tr');
    t.eq('a row per result', rows.length, 3);
    t.eq('source in the first column', rows[0].cells[0].textContent, '68480/2024');
    t.eq('court case number in the third', rows[0].cells[2].textContent, '56226-02-24');
    t.eq('the same source repeats for its second case', rows[1].cells[0].textContent, '68480/2024');
    t.ok('a source with no cases is marked', rows[2].className.indexOf('is-empty') >= 0);
    t.eq('the card is shown', d.getElementById('bulk-results-card').hidden, false);
    t.ok('the count is of real cases only', /2 תיקים/.test(d.getElementById('bulk-count').textContent));
    t.ok('finished state reported', /הסתיים/.test(d.getElementById('bulk-status').textContent));
  }
}

module.exports = { run };
