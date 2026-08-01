// Tests for content/ext-bulk.js — the bulk "תיק מקור → תיקי בית משפט" runner.
//
// The portal's search screen can only be driven one postback at a time (its two
// criteria fields are AutoPostBack controls), so a run over a pasted list walks
// the same sequence once per number and collects the results the page ships as
// JSON in a hidden field. These tests pin one action per page load, the exact
// __EVENTTARGET each step posts, and how results are attributed to their source.

const { loadScripts, readScript } = require('./helpers/env.js');

const EXT_URL = 'https://www.court.gov.il/NGCS.Web.Site/SearchCase/CasesSearchExternalView.aspx';
const TOKEN = 'btest123';

const RESULTS = [
  { CaseTypeShortName: 'ת"פ', CaseDisplayIdentifier: '56226-02-24', CaseName: 'מדינת ישראל נ\' פלוני',
    CaseInterestName: 'פקודת הסמים', CourtName: 'שלום ירושלים', CaseStatusName: 'סגור' },
  { CaseTypeShortName: 'מ"ת', CaseDisplayIdentifier: '56259-02-24', CaseName: 'מדינת ישראל נ\' פלוני',
    CaseInterestName: '', CourtName: 'שלום ירושלים', CaseStatusName: 'סגור' },
];

function screenHtml(store) {
  const opts = [['-1', 'בחר'], ['1', 'דו"ח תעבורה'], ['2', 'תיק משטרתי (פל"א)']]
    .map((p) => '<option value="' + p[0] + '">' + p[1] + '</option>').join('');
  return '<!DOCTYPE html><html><head><title>איתור תיקים לפי מספר תיק מקור</title></head><body>' +
    '<form id="Form">' +
      '<input type="hidden" name="__EVENTTARGET" value="">' +
      '<input type="hidden" name="__EVENTARGUMENT" value="">' +
      '<input type="submit" value="אתר" id="header_CaseLocatorHeaderUC2_SearchHeaderCaseButton">' +
      '<select id="ExternalCaseTypeIDDropDown" name="ExternalCaseTypeIDDropDown" ' +
        'onchange="javascript:setTimeout(\'__doPostBack(\\\'ExternalCaseTypeIDDropDown\\\',\\\'\\\')\', 0)">' +
        opts + '</select>' +
      '<input type="text" id="ExternalCaseNumber" name="ExternalCaseNumber" ' +
        'onchange="javascript:setTimeout(\'__doPostBack(\\\'ExternalCaseNumber\\\',\\\'\\\')\', 0)">' +
      '<a id="buttonsGroup_searchButton" href="javascript:WebForm_DoPostBackWithOptions(new ' +
        'WebForm_PostBackOptions(&quot;buttonsGroup:searchButton&quot;, &quot;&quot;, true, ' +
        '&quot;&quot;, &quot;&quot;, false, true))">אישור</a>' +
      (store === undefined ? '' :
        // The real page emits this JSON as an HTML attribute; case names carry
        // apostrophes ("מדינת ישראל נ' פלוני"), so it must be escaped like one.
        '<input type="hidden" id="CaseSearchResultsGridArrayStore" value="' +
          JSON.stringify(store).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '">') +
    '</form></body></html>';
}

function job(over) {
  return Object.assign({
    token: TOKEN, type: '2', typeLabel: 'תיק משטרתי (פל"א)',
    queue: [], current: '68480/2024', phase: 'number',
    rows: [], total: 1, doneCount: 0, state: 'running', at: Date.now(),
  }, over || {});
}

// Boot the runner against a screen in a given state. `state` is what the page
// already shows, i.e. which of the site's postbacks have landed.
function boot(opts) {
  opts = opts || {};
  const store = { cd_bulk_job: opts.job || job() };
  const env = loadScripts(screenHtml(opts.results), {
    url: EXT_URL, store,
    scripts: ['shared/case-locator.js', 'content/case-open.js'],
  });
  const d = env.window.document;
  if (opts.state && opts.state.type) d.getElementById('ExternalCaseTypeIDDropDown').value = opts.state.type;
  if (opts.state && opts.state.num) d.getElementById('ExternalCaseNumber').value = opts.state.num;
  let submitted = 0;
  d.getElementById('Form').submit = () => { submitted++; };
  if (opts.token !== null) env.window.sessionStorage.setItem('cd_bulk_token', opts.token || TOKEN);
  env.window.eval(readScript('content/ext-bulk.js'));
  if (d.readyState === 'loading') d.dispatchEvent(new env.window.Event('DOMContentLoaded'));
  return {
    env, d,
    submitted: () => submitted,
    evTarget: () => d.querySelector('input[name="__EVENTTARGET"]').value,
    job: () => store.cd_bulk_job,
    veil: () => { try { return env.window.sessionStorage.getItem('cd_bulk_veil'); } catch (e) { return null; } },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function run(t) {
  t.section('ext-bulk: first load lands the source-case type');
  {
    const b = boot({ state: { type: '-1' } });
    await tick(); await tick();
    t.eq('type written', b.d.getElementById('ExternalCaseTypeIDDropDown').value, '2');
    t.eq('one postback', b.submitted(), 1);
    t.eq('__EVENTTARGET is the combo', b.evTarget(), 'ExternalCaseTypeIDDropDown');
    t.ok('the page is covered while it runs', /מריץ 1 מתוך 1/.test(b.veil() || ''));
  }

  t.section('ext-bulk: with the type in place it posts the number');
  {
    const b = boot({ state: { type: '2' } });
    await tick(); await tick();
    t.eq('number written', b.d.getElementById('ExternalCaseNumber').value, '68480/2024');
    t.eq('__EVENTTARGET is the number field', b.evTarget(), 'ExternalCaseNumber');
    t.eq('next load runs the search', b.job().phase, 'search');
    t.eq('one postback', b.submitted(), 1);
  }

  t.section('ext-bulk: then it presses "אישור"');
  {
    const b = boot({ job: job({ phase: 'search' }), state: { type: '2', num: '68480/2024' } });
    await tick(); await tick();
    t.eq('__EVENTTARGET is the search button', b.evTarget(), 'buttonsGroup:searchButton');
    t.eq('next load collects', b.job().phase, 'collect');
    t.eq('one postback', b.submitted(), 1);
  }

  t.section('ext-bulk: one row per case found, tagged with its source number');
  {
    const b = boot({
      job: job({ phase: 'collect', queue: ['132178/2023'], total: 2 }),
      state: { type: '2', num: '68480/2024' },
      results: RESULTS,
    });
    await tick(); await tick();
    const rows = b.job().rows;
    t.eq('two cases → two rows', rows.length, 2);
    t.eq('both carry the source number', rows.every((r) => r.source === '68480/2024'), true);
    t.eq('first case number', rows[0].caseNumber, '56226-02-24');
    t.eq('second case number', rows[1].caseNumber, '56259-02-24');
    t.eq('case type kept', rows[0].caseType, 'ת"פ');
    t.eq('court kept', rows[0].court, 'שלום ירושלים');
    t.eq('counted as done', b.job().doneCount, 1);
    t.eq('moved on to the next source number', b.job().current, '132178/2023');
    t.eq('and posted it', b.evTarget(), 'ExternalCaseNumber');
    t.eq('one postback', b.submitted(), 1);
  }

  t.section('ext-bulk: a source number with no cases still gets a row');
  {
    const b = boot({ job: job({ phase: 'collect' }), state: { type: '2', num: '68480/2024' }, results: [] });
    await tick(); await tick();
    const rows = b.job().rows;
    t.eq('one row', rows.length, 1);
    t.eq('with the source number', rows[0].source, '68480/2024');
    t.eq('and no case number', rows[0].caseNumber, '');
    t.ok('marked as not found', /לא נמצאו/.test(rows[0].status));
  }

  t.section('ext-bulk: the last number ends the run and uncovers the page');
  {
    const b = boot({ job: job({ phase: 'collect' }), state: { type: '2', num: '68480/2024' }, results: RESULTS });
    await tick(); await tick();
    t.eq('state', b.job().state, 'done');
    t.eq('nothing more submitted', b.submitted(), 0);
    t.eq('veil cleared', b.veil(), null);
    t.eq('all results kept', b.job().rows.length, 2);
  }

  t.section('ext-bulk: a type that will not stick cannot loop the run');
  {
    // The screen keeps coming back on the wrong type — after two attempts the
    // run carries on with the number instead of reloading the page forever.
    const b = boot({ job: job({ typeTries: 2 }), state: { type: '1' } });
    await tick(); await tick();
    t.eq('moved on to the number', b.evTarget(), 'ExternalCaseNumber');
    t.eq('one postback', b.submitted(), 1);
  }

  t.section('ext-bulk: only the tab that started the run advances it');
  {
    const b = boot({ token: null, state: { type: '-1' } });   // no token in this tab
    await tick(); await tick();
    t.eq('nothing submitted', b.submitted(), 0);
    t.eq('the job is untouched', b.job().doneCount, 0);
  }

  t.section('ext-bulk: a stopped job is left alone');
  {
    const b = boot({ job: job({ state: 'stopped' }), state: { type: '-1' } });
    await tick(); await tick();
    t.eq('nothing submitted', b.submitted(), 0);
  }
}

module.exports = { run };
