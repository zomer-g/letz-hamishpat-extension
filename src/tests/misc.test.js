// Misc invariant tests. The defense-mode slice rule is a pure rule mirrored
// from list-panel.js processOne() (which can't be loaded standalone — it needs
// JSZip/jsPDF/fetch). Kept as an executable spec of the intended behavior.

function run(t) {
  t.section('defense mode: first+last page slice');
  function defenseSlice(images, defense) {
    if (defense && images.length > 2) return [images[0], images[images.length - 1]];
    return images;
  }
  {
    const out = defenseSlice(['a', 'b', 'c', 'd', 'e'], true);
    t.eq('5 pages → 2', out.length, 2);
    t.eq('keeps first', out[0], 'a');
    t.eq('keeps last', out[1], 'e');
  }
  t.eq('2 pages unchanged', defenseSlice(['a', 'b'], true).length, 2);
  t.eq('1 page unchanged', defenseSlice(['a'], true).length, 1);
  t.eq('defense off → full', defenseSlice(['a', 'b', 'c'], false).length, 3);

  // ── Firefox: where a vendored UMD library lands ───────────────────────────
  // In a Chrome content script `this` / `globalThis` / `window` are one and the
  // same object, so it makes no difference which a bundle attaches itself to.
  // In Firefox they are NOT: jszip.min.js picks `window`, jspdf.umd.min.js picks
  // the top-level `this` — the extension's sandbox — so `window.jspdf` stays
  // undefined and the PDF/ZIP download bailed out with "ספריות הקובץ לא נטענו".
  // Vendored globals must be resolved through the shim, which looks in both.
  t.section('vendor globals: resolved through the compat shim, not off window');
  {
    const fs = require('fs');
    const path = require('path');
    const { loadScripts, EXT_ROOT } = require('./helpers/env.js');
    const env = loadScripts('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://www.court.gov.il/NGCS.Web.Site/HomePage.aspx',
      scripts: ['shared/browser-compat.js'],
    });
    const CD = env.window.CD;
    t.ok('the shim exposes a resolver', typeof CD.vendorGlobal === 'function');
    t.eq('unknown library → null', CD.vendorGlobal('NoSuchLib'), null);
    env.window.JSZip = { tag: 'zip' };
    t.eq('finds a library attached to window', CD.vendorGlobal('JSZip').tag, 'zip');

    // The regression guard: no content script may read a vendored library off
    // `window` alone again — that is precisely what broke the Firefox build.
    const dir = path.join(EXT_ROOT, 'content');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /=\s*w\.(JSZip|jspdf|jsPDF)\b/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    t.eq('no direct window.<lib> reads left', offenders.join(', '), '');
  }

  // Firefox does not run the default action for a click on an element that is
  // not in the document, so a download anchor must be appended before it is
  // clicked. Chrome does it either way, which is how a detached one slips in.
  t.section('downloads: the anchor is in the document before it is clicked');
  {
    const fs = require('fs');
    const path = require('path');
    const { EXT_ROOT } = require('./helpers/env.js');
    const offenders = [];
    for (const dir of ['content', 'popup', 'options', 'about']) {
      const abs = path.join(EXT_ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const f of fs.readdirSync(abs)) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(abs, f), 'utf8');
        if (!/\.download\s*=/.test(src)) continue;              // no download anchor here
        if (!/appendChild\(a\)/.test(src)) offenders.push(dir + '/' + f);
      }
    }
    t.eq('every download anchor is attached first', offenders.join(', '), '');
  }

  // The same endpoint exists under each portal's own application root. Asking
  // the public host for a secured path is answered by the site's WAF with
  // "חסימת בקשה לא מורשית" — verified live — which the downloader read as the
  // court throttling it, so it waited out a cooldown having fetched nothing.
  t.section('portal root: derived from the page, not assumed to be secured');
  {
    const { loadScripts } = require('./helpers/env.js');
    const cases = [
      ['public decisions list', 'https://www.court.gov.il/NGCS.Web.Site/Decisions/DecisionList.aspx', '/NGCS.Web.Site'],
      ['securesso case page', 'https://securesso.court.gov.il/Ngcs.Web.Secured/Decision/DecisionList.aspx', '/Ngcs.Web.Secured'],
      ['secure (smart card)', 'https://secure.court.gov.il/NGCS.Web.Secured/CaseFile/PresentDocument.aspx', '/NGCS.Web.Secured'],
    ];
    for (const [label, url, expected] of cases) {
      const env = loadScripts('<!DOCTYPE html><html><body></body></html>', { url, scripts: ['shared/constants.js'] });
      t.eq(label, env.window.CD.appRoot(), expected);
    }
    const env = loadScripts('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://www.court.gov.il/NGCS.Web.Site/HomePage.aspx', scripts: ['shared/constants.js'],
    });
    t.eq('resolves for another page too',
      env.window.CD.appRoot('https://securesso.court.gov.il/Ngcs.Web.Secured/PersonalAreaPage.aspx'), '/Ngcs.Web.Secured');

    // Regression guard: nothing may hard-code a secured path into a request.
    const fs = require('fs');
    const path = require('path');
    const { EXT_ROOT } = require('./helpers/env.js');
    const dir = path.join(EXT_ROOT, 'content');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                        // comments describe them freely
        if (/['"]\/[Nn][Gg][Cc][Ss]\.[Ww]eb\.[Ss]ecured\//.test(line) &&
            !/HomePage\.aspx|PersonalAreaPage\.aspx/.test(line)) {     // login-only screens are secured by nature
          offenders.push(f + ':' + (i + 1));
        }
      });
    }
    t.eq('no hard-coded secured request paths', offenders.join(', '), '');
  }
}

module.exports = { run };
