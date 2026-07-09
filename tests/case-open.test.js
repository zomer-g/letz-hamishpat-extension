// Tests for content/case-open.js — the quick-open filler that drives Net
// HaMishpat's own "איתור תיק" bar. Uses a synthetic locator DOM mirroring the
// real element ids discovered live (Header1_CaseLocatorHeaderUC2_*).

const { loadScripts } = require('./helpers/env.js');

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
