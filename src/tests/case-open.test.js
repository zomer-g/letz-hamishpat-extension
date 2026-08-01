// Tests for content/case-open.js — the quick-open filler that drives Net
// HaMishpat's own "איתור תיק" bar. Uses a synthetic locator DOM mirroring the
// real element ids discovered live (Header1_CaseLocatorHeaderUC2_*).

const { loadScripts, readScript } = require('./helpers/env.js');

const COURT_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/PersonalAreaPage.aspx';

function locatorHtml() {
  const P = 'Header1_CaseLocatorHeaderUC2_';
  return '<!DOCTYPE html><html><head><title>אזור אישי</title></head><body>' +
    '<form id="Form1">' +
      '<input type="radio" id="' + P + 'BamaCaseIdentifierOptionBoxHT">' +
      '<input type="radio" id="' + P + 'OldCaseIdentifierOptionBoxHT">' +
      '<select id="' + P + 'NumeratorGroupTypeComboBoxHT">' +
        '<option value="1">תיק בית משפט</option><option value="2">תיק תעבורה</option>' +
      '</select>' +
      '<input type="text" maxlength="5" id="' + P + 'BamaMonthYearTextBoxHT">' +
      '<input type="text" maxlength="6" id="' + P + 'BamaCaseNumberTextBoxHT">' +
      '<input type="submit" value="אתר" id="' + P + 'SearchHeaderCaseButton">' +
    '</form></body></html>';
}

function load() {
  const env = loadScripts(locatorHtml(), {
    url: COURT_URL,
    scripts: ['shared/case-locator.js', 'content/case-open.js'],
  });
  const d = env.window.document;
  const el = (s) => d.getElementById('Header1_CaseLocatorHeaderUC2_' + s);
  // Spy on the native submit so the test doesn't actually navigate.
  let clicked = 0;
  el('SearchHeaderCaseButton').click = () => { clicked++; };
  return { env, el, clicked: () => clicked };
}

function run(t) {
  t.section('case-open: fills the locator fields and submits');
  {
    const { env, el, clicked } = load();
    const r = env.CD.caseOpenSubmit('39163-07-22');
    t.eq('returns ok', r.ok, true);
    t.eq('serial → BamaCaseNumberTextBoxHT', el('BamaCaseNumberTextBoxHT').value, '39163');
    t.eq('month-year → MM-YY', el('BamaMonthYearTextBoxHT').value, '07-22');
    t.eq('new-case radio checked', el('BamaCaseIdentifierOptionBoxHT').checked, true);
    t.eq('type combo forced to 1 (בית משפט)', el('NumeratorGroupTypeComboBoxHT').value, '1');
    t.eq('submit clicked once', clicked(), 1);
  }

  t.section('case-open: accepts alternate formats (slash, 4-digit year)');
  {
    const { env, el } = load();
    env.CD.caseOpenSubmit('80819/05/2026');
    t.eq('serial from slashed input', el('BamaCaseNumberTextBoxHT').value, '80819');
    t.eq('MM-YY from 4-digit year', el('BamaMonthYearTextBoxHT').value, '05-26');
  }

  t.section('case-open: rejects invalid input without submitting');
  {
    const { env, el, clicked } = load();
    const r = env.CD.caseOpenSubmit('3916322'); // no separators
    t.eq('returns not-ok', r.ok, false);
    t.ok('error mentions example', /39163/.test(r.error || ''));
    t.eq('serial left empty', el('BamaCaseNumberTextBoxHT').value, '');
    t.eq('nothing submitted', clicked(), 0);
  }

  // The PUBLIC site (www.court.gov.il/NGCS.Web.Site) uses a DIFFERENT locator
  // than the secured header: control CaseLocatorUC1, field suffix "VT", submit
  // button "ButtonsGroup1_btnLocate" captioned "איתור", and a required "סדרה"
  // combo whose options DON'T include value "1". The old code (HT-only, caption
  // "אתר", combo forced to "1") left that page's series empty → the site error
  // "חובה להזין ערך בשדה סדרה". This is the regression guard for that.
  t.section('case-open: drives the PUBLIC (VT) locator and fills the "סדרה" combo');
  {
    const publicHtml = '<!DOCTYPE html><html><head><title>נט המשפט</title></head><body>' +
      '<form id="Form1">' +
        '<input type="radio" id="CaseLocatorUC1_BamaCaseIdentifierOptionBoxVT">' +
        '<select id="CaseLocatorUC1_NumeratorGroupTypeComboBoxVT">' +
          '<option value="-1">בחר/י סדרה</option>' +
          '<option value="3">תיק בית משפט</option><option value="5">תיק תעבורה</option>' +
        '</select>' +
        '<input type="text" maxlength="5" id="CaseLocatorUC1_BamaMonthYearTextBoxVT">' +
        '<input type="text" maxlength="6" id="CaseLocatorUC1_BamaCaseNumberTextBoxVT">' +
        '<input type="submit" value="איתור" id="ButtonsGroup1_btnLocate">' +
      '</form></body></html>';
    const env = loadScripts(publicHtml, {
      url: 'https://www.court.gov.il/NGCS.Web.Site/HomePage.aspx',
      scripts: ['shared/case-locator.js', 'content/case-open.js'],
    });
    const d = env.window.document;
    let clicked = 0;
    d.getElementById('ButtonsGroup1_btnLocate').click = () => { clicked++; };
    const r = env.CD.caseOpenSubmit('עת"מ 40348-05-20 זומר נ\' אנגל ואח\'');
    t.eq('returns ok on the public locator', r.ok, true);
    t.eq('serial → VT case field', d.getElementById('CaseLocatorUC1_BamaCaseNumberTextBoxVT').value, '40348');
    t.eq('month-year → VT MM-YY', d.getElementById('CaseLocatorUC1_BamaMonthYearTextBoxVT').value, '05-20');
    t.eq('"סדרה" combo set to תיק בית משפט (value 3, no value 1 here)', d.getElementById('CaseLocatorUC1_NumeratorGroupTypeComboBoxVT').value, '3');
    t.eq('public "איתור" button clicked', clicked, 1);
  }

  // ── search by "תיק מקור" (source case) ─────────────────────────────────────
  // The portal's own screen: איתור תיקים → "תיקים לפי מס' תיק מקור"
  // (SearchCase/CasesSearchExternalView.aspx). Element ids captured live.
  const EXT_URL = 'https://www.court.gov.il/NGCS.Web.Site/SearchCase/CasesSearchExternalView.aspx';
  const HOME_URL = 'https://www.court.gov.il/NGCS.Web.Site/HomePage.aspx';

  function extOptions(values) {
    // Default = the site's real values; `values` overrides them (renumber test).
    const pairs = values || [
      ['-1', 'בחר'], ['11', 'בית דין מנהלי לתעבורה'], ['7', 'דו"ח עירייה'], ['1', 'דו"ח תעבורה'],
      ['10', 'הודעת קנס'], ['6', 'כונס הנכסים הרשמי'], ['8', 'עמ"ק ישן'], ['9', 'עניינים מקומיים'],
      ['3', 'תיק הוצל"פ'], ['2', 'תיק משטרתי (פל"א)'],
    ];
    return pairs.map((p) => '<option value="' + p[0] + '">' + p[1] + '</option>').join('');
  }
  // The real screen's "אישור" is an <a href="javascript:…WebForm_PostBackOptions
  // ("buttonsGroup:searchButton"…)">. A content script CANNOT drive it with
  // .click() — the javascript: URL runs in the extension's isolated world, where
  // the page's postback helpers don't exist, so the click does nothing at all.
  // The fixture therefore mirrors the real markup (hidden __EVENTTARGET +
  // javascript: href) and the tests assert we submit the form ourselves.
  // Both criteria fields are AutoPostBack controls — their onchange fires the
  // site's own __doPostBack (nested in a setTimeout string, escaped quotes and
  // all), and the server builds the query from those round-trips. The fixture
  // reproduces that markup because the whole three-step sequence depends on it.
  function externalHtml(values) {
    const opts = extOptions(values);
    return '<!DOCTYPE html><html><head><title>איתור תיקים לפי מספר תיק מקור</title></head><body>' +
      '<form id="Form">' +
        '<input type="hidden" name="__EVENTTARGET" value="">' +
        '<input type="hidden" name="__EVENTARGUMENT" value="">' +
        // the site's header locator is present here too, so the panel still mounts
        '<input type="text" id="header_CaseLocatorHeaderUC2_BamaCaseNumberTextBoxHT">' +
        '<input type="text" id="header_CaseLocatorHeaderUC2_BamaMonthYearTextBoxHT">' +
        '<input type="submit" value="אתר" id="header_CaseLocatorHeaderUC2_SearchHeaderCaseButton">' +
        '<select id="ExternalCaseTypeIDDropDown" name="ExternalCaseTypeIDDropDown" ' +
          'onchange="javascript:setTimeout(\'__doPostBack(\\\'ExternalCaseTypeIDDropDown\\\',\\\'\\\')\', 0)">' +
          opts + '</select>' +
        '<input type="text" id="ExternalCaseNumber" name="ExternalCaseNumber" ' +
          'onchange="javascript:setTimeout(\'__doPostBack(\\\'ExternalCaseNumber\\\',\\\'\\\')\', 0)">' +
        '<a id="buttonsGroup_searchButton" href="javascript:WebForm_DoPostBackWithOptions(new ' +
          'WebForm_PostBackOptions(&quot;buttonsGroup:searchButton&quot;, &quot;&quot;, true, ' +
          '&quot;&quot;, &quot;&quot;, false, true))">אישור</a>' +
      '</form></body></html>';
  }
  function loadExternal(opts) {
    opts = opts || {};
    const env = loadScripts(externalHtml(opts.values), {
      url: EXT_URL, scripts: ['shared/case-locator.js'],
    });
    if (opts.pending) env.window.sessionStorage.setItem('cd_extsearch', JSON.stringify(opts.pending));
    const d = env.window.document;
    // `state` = what the screen already holds, i.e. which of the site's own
    // postback steps have landed before this load.
    if (opts.state) {
      if (opts.state.type) d.getElementById('ExternalCaseTypeIDDropDown').value = opts.state.type;
      if (opts.state.num) d.getElementById('ExternalCaseNumber').value = opts.state.num;
    }
    let clicked = 0, submitted = 0;
    d.getElementById('buttonsGroup_searchButton').click = () => { clicked++; };
    d.getElementById('Form').submit = () => { submitted++; };   // jsdom can't navigate
    env.window.eval(readScript('content/case-open.js')); // after the stash is in place
    // jsdom can still report readyState "loading" here, so boot() parked itself
    // on DOMContentLoaded; in a real browser the script runs at document_idle.
    if (d.readyState === 'loading') d.dispatchEvent(new env.window.Event('DOMContentLoaded'));
    const evTarget = () => d.querySelector('input[name="__EVENTTARGET"]').value;
    return { env, d, clicked: () => clicked, submitted: () => submitted, evTarget };
  }

  // The site's two criteria fields are AutoPostBack controls and the server
  // builds the query from THOSE round-trips: setting both and pressing אישור in
  // one shot comes back with 0 results even for a case that exists (verified
  // live against a real פל"א). So each page load must advance exactly one step.
  t.section('case-open: step 1 — the type change is posted on its own');
  {
    const { env, d, clicked, submitted, evTarget } = loadExternal();
    const r = env.CD.caseOpenSubmitExternal('1', ' 12345678 ');
    t.eq('returns ok', r.ok, true);
    t.eq('סוג תיק מקור set to דו"ח תעבורה (value 1)', d.getElementById('ExternalCaseTypeIDDropDown').value, '1');
    t.eq('the number is NOT filled yet — that is the next round-trip',
      d.getElementById('ExternalCaseNumber').value, '');
    t.eq('one postback', submitted(), 1);
    t.eq('__EVENTTARGET carries the combo, not the search button', evTarget(), 'ExternalCaseTypeIDDropDown');
    t.eq('no reliance on clicking the javascript: link', clicked(), 0);
    const stash = JSON.parse(env.window.sessionStorage.getItem('cd_extsearch') || 'null');
    t.eq('the query stays stashed for the next load', stash && stash.num, '12345678');
  }

  t.section('case-open: step 2 — with the type in place, the number is posted');
  {
    const { d, submitted, evTarget } = loadExternal({
      state: { type: '2' },
      pending: { type: '2', num: '68480/2024', at: Date.now() },
    });
    t.eq('number written', d.getElementById('ExternalCaseNumber').value, '68480/2024');
    t.eq('one postback', submitted(), 1);
    t.eq('__EVENTTARGET carries the number field', evTarget(), 'ExternalCaseNumber');
  }

  t.section('case-open: step 3 — both criteria registered, "אישור" is pressed');
  {
    const { env, submitted, evTarget } = loadExternal({
      state: { type: '2', num: '68480/2024' },
      pending: { type: '2', num: '68480/2024', at: Date.now() },
    });
    t.eq('one postback', submitted(), 1);
    t.eq('__EVENTTARGET carries the "אישור" control', evTarget(), 'buttonsGroup:searchButton');
    t.eq('the query is done — nothing left to replay',
      env.window.sessionStorage.getItem('cd_extsearch'), null);
    const done = JSON.parse(env.window.sessionStorage.getItem('cd_extdone') || 'null');
    t.eq('the search is marked for reporting', done && done.num, '68480/2024');
  }

  t.section('case-open: source-case type falls back to matching by caption');
  {
    // Same captions, different values — the site renumbering must not break us.
    const { env, d } = loadExternal({ values: [['-1', 'בחר'], ['501', 'דו"ח תעבורה'], ['502', 'תיק הוצל"פ']] });
    const r = env.CD.caseOpenSubmitExternal('3', '77'); // 3 = תיק הוצל"פ in our list
    t.eq('returns ok', r.ok, true);
    t.eq('matched by caption → the site\'s own value', d.getElementById('ExternalCaseTypeIDDropDown').value, '502');
  }

  t.section('case-open: source-case search validates its input');
  {
    const { env, submitted: clicked } = loadExternal();
    const noNum = env.CD.caseOpenSubmitExternal('1', '   ');
    t.eq('empty number → not-ok', noNum.ok, false);
    t.ok('error names the type', /דו"ח תעבורה/.test(noNum.error || ''));
    const noType = env.CD.caseOpenSubmitExternal('', '12345678');
    t.eq('no type chosen → not-ok', noType.ok, false);
    const badType = env.CD.caseOpenSubmitExternal('999', '12345678');
    t.eq('unknown type → not-ok', badType.ok, false);
    t.eq('nothing submitted', clicked(), 0);
  }

  t.section('case-open: from another page it stashes the query and walks the menu link');
  {
    const html = '<!DOCTYPE html><html><head><title>נט המשפט</title></head><body><form id="Form1">' +
      '<input type="hidden" name="__EVENTTARGET" value="">' +
      '<input type="hidden" name="__EVENTARGUMENT" value="">' +
      '<input type="text" id="Header1_CaseLocatorHeaderUC2_BamaCaseNumberTextBoxHT">' +
      '<input type="text" id="Header1_CaseLocatorHeaderUC2_BamaMonthYearTextBoxHT">' +
      '<input type="submit" value="אתר" id="Header1_CaseLocatorHeaderUC2_SearchHeaderCaseButton">' +
      '<a id="Header1_UpperMenu1_btnExternalSearchCases" ' +
        'href="javascript:__doPostBack(&#39;Header1$UpperMenu1$btnExternalSearchCases&#39;,&#39;&#39;)">' +
        'תיקים לפי מס\' תיק מקור</a>' +
      '</form></body></html>';
    const env = loadScripts(html, { url: HOME_URL, scripts: ['shared/case-locator.js', 'content/case-open.js'] });
    const d = env.window.document;
    let submitted = 0;
    d.getElementById('Form1').submit = () => { submitted++; };
    const r = env.CD.caseOpenSubmitExternal('7', '2024/99');
    t.eq('returns ok (navigating)', r.ok, true);
    t.eq('navigated by the site\'s own postback', submitted, 1);
    t.eq('__EVENTTARGET carries the menu control',
      d.querySelector('input[name="__EVENTTARGET"]').value, 'Header1$UpperMenu1$btnExternalSearchCases');
    const stash = JSON.parse(env.window.sessionStorage.getItem('cd_extsearch') || 'null');
    t.eq('type stashed', stash && stash.type, '7');
    t.eq('number stashed', stash && stash.num, '2024/99');
    t.ok('stash is timestamped', typeof (stash && stash.at) === 'number');
  }

  t.section('case-open: a stale stash is dropped instead of replayed');
  {
    const { d, submitted } = loadExternal({ pending: { type: '2', num: '404040', at: Date.now() - 5 * 60000 } });
    t.eq('nothing submitted', submitted(), 0);
    t.eq('the screen was left alone', d.getElementById('ExternalCaseNumber').value, '');
  }

  // A search that ran and found nothing leaves a screen that looks exactly like
  // one that was only filled in — so the panel has to say which it was.
  t.section('case-open: reports the outcome of the search it just ran');
  {
    const env = loadScripts(
      externalHtml().replace('</form>', '</form><div>0 עד 0 מתוך 0</div>'),
      { url: EXT_URL, scripts: ['shared/case-locator.js'] });
    env.window.sessionStorage.setItem('cd_extdone', JSON.stringify({ type: '1', num: '555', at: Date.now() }));
    const d = env.window.document;
    d.getElementById('Form').submit = () => {};
    env.window.eval(readScript('content/case-open.js'));
    if (d.readyState === 'loading') d.dispatchEvent(new env.window.Event('DOMContentLoaded'));
    const status = d.querySelector('#cd-caseopen-panel .cd-co__status');
    t.ok('a status is shown', !!status && !status.hidden);
    t.ok('it says nothing was found', /לא נמצאו/.test(status.textContent));
    t.ok('it names the search', /דו"ח תעבורה 555/.test(status.textContent));
    t.eq('the panel keeps the searched type', d.querySelector('.cd-co__type').value, '1');
    t.eq('the panel keeps the searched number', d.querySelector('.cd-co__input').value, '555');
    t.eq('the marker is consumed', env.window.sessionStorage.getItem('cd_extdone'), null);
  }

  t.section('case-open: reports how many cases the search found');
  {
    const env = loadScripts(
      externalHtml().replace('</form>', '</form><div>1 עד 3 מתוך 3</div>'),
      { url: EXT_URL, scripts: ['shared/case-locator.js'] });
    env.window.sessionStorage.setItem('cd_extdone', JSON.stringify({ type: '3', num: '01-99', at: Date.now() }));
    const d = env.window.document;
    d.getElementById('Form').submit = () => {};
    env.window.eval(readScript('content/case-open.js'));
    if (d.readyState === 'loading') d.dispatchEvent(new env.window.Event('DOMContentLoaded'));
    const status = d.querySelector('#cd-caseopen-panel .cd-co__status');
    t.ok('the count comes from the site pager', /נמצאו 3 תיקים/.test(status.textContent));
  }

  t.section('case-open: picks up a stashed query on arrival at the screen');
  {
    const { env, d, submitted } = loadExternal({ pending: { type: '2', num: '404040', at: Date.now() } });
    t.eq('type applied from the stash', d.getElementById('ExternalCaseTypeIDDropDown').value, '2');
    t.eq('submitted once', submitted(), 1);
    const stash = JSON.parse(env.window.sessionStorage.getItem('cd_extsearch') || 'null');
    t.eq('the rest of the query survives for the next step', stash && stash.num, '404040');
    t.eq('the step is counted so a stuck field can not loop', stash && stash.typeTries, 1);
  }

  t.section('case-open: a field the site keeps rejecting does not loop forever');
  {
    // The screen comes back with a type that never becomes ours: after two
    // attempts we move on rather than reload the page again and again.
    const q = { type: '2', num: '404040', at: Date.now(), typeTries: 2 };
    const { d, submitted, evTarget } = loadExternal({ state: { type: '1' }, pending: q });
    t.eq('moved on to the number instead', d.getElementById('ExternalCaseNumber').value, '404040');
    t.eq('one postback', submitted(), 1);
    t.eq('__EVENTTARGET moved past the combo', evTarget(), 'ExternalCaseNumber');
  }

  // The intermediate postbacks would otherwise flash a half-filled search form.
  t.section('ext-busy: covers the page while a source-case query is in flight');
  {
    const env = loadScripts(externalHtml(), { url: EXT_URL, scripts: [] });
    env.window.sessionStorage.setItem('cd_extsearch',
      JSON.stringify({ type: '2', num: '68480/2024', at: Date.now() }));
    env.window.eval(readScript('content/ext-busy.js'));
    const d = env.window.document;
    const veil = d.getElementById('cd-busy-veil');
    t.ok('a veil is raised', !!veil);
    t.ok('it names the case being searched', /68480\/2024/.test(veil.textContent));
    t.ok('the page itself is hidden behind it', d.documentElement.classList.contains('cd-busy'));
    env.window.CD.extVeilHide();
    t.eq('and it comes down on demand', d.getElementById('cd-busy-veil'), null);
    t.ok('the page is uncovered', !d.documentElement.classList.contains('cd-busy'));
  }

  t.section('ext-busy: leaves an ordinary page alone');
  {
    const env = loadScripts(externalHtml(), { url: EXT_URL, scripts: [] });
    env.window.eval(readScript('content/ext-busy.js'));      // no pending query
    t.eq('no veil', env.window.document.getElementById('cd-busy-veil'), null);
    const stale = loadScripts(externalHtml(), { url: EXT_URL, scripts: [] });
    stale.window.sessionStorage.setItem('cd_extsearch',
      JSON.stringify({ type: '2', num: '9', at: Date.now() - 5 * 60000 }));
    stale.window.eval(readScript('content/ext-busy.js'));
    t.eq('a stale query raises no veil', stale.window.document.getElementById('cd-busy-veil'), null);
  }

  t.section('case-open: the panel offers the closed source-case list');
  {
    const { env } = loadExternal();
    const sel = env.window.document.querySelector('#cd-caseopen-panel .cd-co__type');
    t.ok('type combo rendered in the panel', !!sel);
    const opts = Array.prototype.map.call(sel.options, (o) => o.value);
    t.eq('default option keeps the paste-a-number behaviour', opts[0], '');
    t.eq('one option per source-case type', opts.length - 1, env.CD.EXTERNAL_CASE_TYPES.length);
    t.ok('דו"ח תעבורה is in the list',
      Array.prototype.some.call(sel.options, (o) => /דו"ח תעבורה/.test(o.textContent)));
  }

  t.section('case-open: reports when the locator bar is absent');
  {
    const env = loadScripts('<!DOCTYPE html><html><body><div>no locator here</div></body></html>', {
      url: COURT_URL, scripts: ['shared/case-locator.js', 'content/case-open.js'],
    });
    const r = env.CD.caseOpenSubmit('39163-07-22');
    t.eq('valid number but no bar → not-ok', r.ok, false);
    t.ok('error mentions the locator bar', /איתור/.test(r.error || ''));
  }
}

module.exports = { run };
