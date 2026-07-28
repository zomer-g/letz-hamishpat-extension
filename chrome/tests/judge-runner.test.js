// Tests for content/judge-runner.js — currently the mojibake (◆ / U+FFFD)
// detection that triggers the clean re-fetch: Net HaMishpat's server sometimes
// returns a UTF-8 body that the tab decodes as windows-1255, turning every
// Hebrew letter into two replacement chars. CD.judgeHasFFFD is the gate.

const { loadScripts } = require('./helpers/env.js');

const COURT_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/PersonalAreaPage.aspx';
const PAGE = '<!DOCTYPE html><html><body><form id="f"><input name="__EVENTTARGET"><input name="__EVENTARGUMENT"></form></body></html>';

async function run(t) {
  t.section('judge-runner: mojibake detection (CD.judgeHasFFFD)');
  {
    const env = loadScripts(PAGE, {
      url: COURT_URL, store: {},
      scripts: ['shared/constants.js', 'content/judge-runner.js'],
    });
    const CD = env.CD;
    t.ok('helper exposed', typeof CD.judgeHasFFFD === 'function');
    t.ok('clean Hebrew rows pass', CD.judgeHasFFFD([
      { caseName: "חצבני נ' מדינת ישראל", sittingType: 'דיון בערעור פלילי' },
    ]) === false);
    t.ok('corrupted rows detected (caseName)', CD.judgeHasFFFD([
      { caseName: '����', sittingType: '' },
    ]) === true);
    t.ok('corrupted rows detected (sittingType only)', CD.judgeHasFFFD([
      { caseName: '12345-06-25', sittingType: '��' },
    ]) === true);
    t.ok('empty list passes', CD.judgeHasFFFD([]) === false);
    // NOTE: repair is a same-day RE-SUBMIT via the normal postback (judge-runner
    // drive / hearings-panel judgeStep). A fetch-replay repair was tried and
    // REVERTED — it desyncs the server's report state (days duplicate/shift).
    t.ok('no fetch-replay helper (reverted by design)', CD.judgeRefetchCleanRows === undefined);
  }
}

module.exports = { run };
