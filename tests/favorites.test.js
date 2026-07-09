// Tests for content/favorites.js — the local ⭐ favorite-cases panel: it mounts
// on a page with the locator bar, the star saves the current case (id + name)
// to chrome.storage, and "כניסה" opens a saved case via CD.caseOpenSubmit.

const { loadScripts } = require('./helpers/env.js');

const COURT_URL = 'https://securesso.court.gov.il/Ngcs.Web.Secured/Decisions/DecisionList.aspx';

function casePageHtml() {
  const P = '_ctl0_Header_CaseLocatorHeaderUC2_';
  // Mirrors the real banner structure: the type+number in one leaf, the parties
  // title in the NEXT leaf (": X נ' Y") — currentCase must stitch them.
  return '<!DOCTYPE html><html><body>' +
    '<div id="_ctl0_Header_CaseLocator"><span>ת"א 39163-07-22</span><span>: בנק מזרחי נ\' טפחות ואח\'</span><span>חופש המידע</span></div>' +
    '<form id="Form1">' +
      '<input type="radio" id="' + P + 'BamaCaseIdentifierOptionBoxHT">' +
      '<select id="' + P + 'NumeratorGroupTypeComboBoxHT"><option value="1">תיק בית משפט</option></select>' +
      '<input type="text" maxlength="5" id="' + P + 'BamaMonthYearTextBoxHT">' +
      '<input type="text" maxlength="6" id="' + P + 'BamaCaseNumberTextBoxHT">' +
      '<input type="submit" value="אתר" id="' + P + 'SearchHeaderCaseButton">' +
    '</form></body></html>';
}

async function run(t) {
  t.section('favorites: star saves the current case, and "כניסה" opens it');
  {
    const env = loadScripts(casePageHtml(), {
      url: COURT_URL, store: {},
      scripts: ['content/adapters/net-court.js', 'content/case-open.js', 'content/favorites.js'],
    });
    const w = env.window, d = w.document;
    await new Promise((r) => setTimeout(r, 750)); // mount bootstrap tick
    const panel = d.getElementById('cd-fav-panel');
    t.ok('favorites panel mounted', !!panel);
    const toggle = panel && panel.querySelector('.cd-fav-toggle');
    t.ok('shows the "add current case" star (on a case page)', !!toggle);
    t.ok('empty list initially', !!(panel && /אין תיקים מועדפים/.test(panel.textContent)));
    // The list is collapsed by default (it can grow long) with an expand button.
    const expandBtn = panel && panel.querySelector('.cd-fav-expand');
    t.ok('has an expand/collapse button', !!expandBtn);
    t.ok('list body hidden by default', !!(panel && panel.querySelector('.cd-fav__body[hidden]')));
    if (expandBtn) {
      expandBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      t.ok('expand shows the list body', !!panel.querySelector('.cd-fav__body') && !panel.querySelector('.cd-fav__body[hidden]'));
    }

    // Re-query after the expand re-render (innerHTML replaced the buttons).
    const star = panel && panel.querySelector('.cd-fav-toggle');
    if (star) {
      star.click();
      await new Promise((r) => setTimeout(r, 100)); // storage set + re-render
      const favs = await new Promise((res) => w.chrome.storage.local.get('cd_favorites', (x) => res((x && x.cd_favorites) || [])));
      t.eq('one favorite saved to storage', favs.length, 1);
      t.eq('saved the case id', favs[0] && favs[0].id, '39163-07-22');
      t.eq('saved the case-type prefix', favs[0] && favs[0].type, 'ת"א');
      t.ok('saved the FULL parties title (X נ\' Y)', !!(favs[0] && /מזרחי נ' טפחות/.test(favs[0].name || '')));
      t.ok('title does not swallow the next banner field', !/חופש המידע/.test((favs[0] && favs[0].name) || ''));

      let opened = null;
      w.CD.caseOpenSubmit = (id) => { opened = id; return { ok: true }; };
      const openBtn = d.querySelector('#cd-fav-panel .cd-fav-open');
      t.ok('list shows a "כניסה" button', !!openBtn);
      if (openBtn) { openBtn.click(); t.eq('כניסה opens the case via caseOpenSubmit', opened, '39163-07-22'); }

      const rm = d.querySelector('#cd-fav-panel .cd-fav-rm');
      if (rm) {
        rm.click();
        await new Promise((r) => setTimeout(r, 100));
        const after = await new Promise((res) => w.chrome.storage.local.get('cd_favorites', (x) => res((x && x.cd_favorites) || [])));
        t.eq('remove empties the list', after.length, 0);
      }
    }
  }
}

module.exports = { run };
