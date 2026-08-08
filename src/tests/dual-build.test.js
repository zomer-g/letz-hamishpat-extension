// Tests for the dual-target build contract (build-zip.js).
//
// One source tree ships to two stores, and the ONLY thing that may differ is
// the manifest. These tests pin that: the Firefox transform produces exactly
// the manifest AMO requires, the Chrome manifest is left alone, and the
// cross-browser compat shim stays first in the content-script list (it aliases
// chrome→browser, so anything loading before it would break on Firefox).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function chromeManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
}

// Build the Firefox manifest through the real build script, so the test
// exercises the shipped code path rather than a copy of its logic.
function firefoxManifest() {
  execFileSync(process.execPath, [path.join(ROOT, 'build-zip.js'), '--target=firefox'],
    { cwd: ROOT, stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'firefox', 'manifest.json'), 'utf8'));
}

async function run(t) {
  const chrome = chromeManifest();

  t.section('dual-build: the compat shim loads before everything else');
  {
    const js = chrome.content_scripts[0].js;
    t.eq('shared/browser-compat.js is first', js[0], 'shared/browser-compat.js');
    t.ok('the shim file exists', fs.existsSync(path.join(ROOT, 'shared', 'browser-compat.js')));
  }

  t.section('dual-build: Chrome manifest keeps its Chrome-only shape');
  {
    t.ok('background is a service worker', !!chrome.background.service_worker);
    t.ok('has the oauth2 block (chrome.identity.getAuthToken)', !!chrome.oauth2);
    t.ok('no gecko settings leak into the Chrome build', !chrome.browser_specific_settings);
  }

  // `key` pins the extension ID for UNPACKED dev loads. Without it Chrome
  // derives the id from the install path, chrome.identity.getAuthToken runs
  // against an id the OAuth client was never registered for, and every
  // Drive/Calendar sign-in fails with "bad client id" — which is exactly what
  // happened when this build was first loaded unpacked. It must stay in source
  // and must never reach a store package.
  t.section('dual-build: the dev signing key never ships');
  {
    const crypto = require('crypto');
    t.ok('source manifest carries the key', typeof chrome.key === 'string' && chrome.key.length > 300);
    // The id Chrome derives: sha256 of the DER public key, first 16 bytes,
    // each nibble mapped 0-15 → a-p.
    const h = crypto.createHash('sha256').update(Buffer.from(chrome.key, 'base64')).digest();
    let id = '';
    for (let i = 0; i < 16; i++) {
      id += String.fromCharCode(97 + (h[i] >> 4)) + String.fromCharCode(97 + (h[i] & 15));
    }
    t.eq('it derives the published Chrome Web Store id', id, 'mlbkjgpedfodphblhgamfgelidgmlmin');

    execFileSync(process.execPath, [path.join(ROOT, 'build-zip.js'), '--target=chrome'],
      { cwd: ROOT, stdio: 'ignore' });
    const JSZip = require(path.join(ROOT, 'vendor', 'jszip.min.js'));
    const zipPath = path.join(ROOT, 'dist', 'extension-v' + chrome.version + '.zip');
    const z = await new JSZip().loadAsync(fs.readFileSync(zipPath));
    const packedMf = JSON.parse(await z.file('manifest.json').async('string'));
    t.ok('the Chrome package has no key', !('key' in packedMf));
    t.eq('the package still has the right version', packedMf.version, chrome.version);
  }

  // AMO asks for "Notes to Reviewer" on EVERY version, and — because the
  // package carries minified third-party libraries — for build instructions
  // that reproduce an exact copy. Generating them with the package is what
  // stops the version, the file count and the vendor hashes from drifting away
  // from what is actually submitted.
  t.section('dual-build: the Firefox build emits reviewer notes');
  {
    const notesPath = path.join(ROOT, 'dist', 'AMO-reviewer-notes-v' + chrome.version + '.txt');
    t.ok('notes were written next to the package', fs.existsSync(notesPath));
    const notes = fs.readFileSync(notesPath, 'utf8');
    t.ok('no unfilled placeholder', !/\{\{\w+\}\}/.test(notes));
    t.ok('states this version', notes.indexOf('Version ' + chrome.version) !== -1);
    t.ok('gives step-by-step build instructions', /npm run build:firefox/.test(notes));
    t.ok('names the exact package it describes',
      notes.indexOf('firefox-extension-v' + chrome.version + '.zip') !== -1);
    t.ok('addresses the minified-source requirement', /MINIFIED CODE/.test(notes));
    t.ok('declares the jsPDF patch rather than claiming none', /MODIFIED\s*:\s*YES/.test(notes));
    t.ok('tells the reviewer how to try it without an Israeli login',
      /www\.court\.gov\.il/.test(notes));
    // The notes must never be packaged INTO the add-on — they are submission
    // metadata, pasted into a form field.
    t.ok('notes live in dist/, not in the package', notesPath.indexOf(path.join('dist', 'AMO')) !== -1);
  }

  const ff = firefoxManifest();
  t.ok('the Firefox manifest has no key', !('key' in ff));

  t.section('dual-build: Firefox manifest satisfies AMO');
  {
    t.eq('version matches Chrome (one tree, one version)', ff.version, chrome.version);
    // Firefox MV3 has no service worker — it runs an event page.
    t.ok('background converted to scripts', Array.isArray(ff.background.scripts));
    t.eq('event page runs the same worker file', ff.background.scripts[0], chrome.background.service_worker);
    t.ok('service_worker key removed', !ff.background.service_worker);
    // Chrome-only key; on Firefox the flow uses identity.launchWebAuthFlow.
    t.ok('oauth2 stripped', !ff.oauth2);

    const gecko = (ff.browser_specific_settings || {}).gecko || {};
    t.ok('has a permanent add-on id', /@/.test(gecko.id || ''));
    // Mandatory for every new AMO submission since 2025-11-03; needs FF 140+.
    t.deepEq('declares "collects no data"', gecko.data_collection_permissions, { required: ['none'] });
    t.eq('strict_min_version supports that key', gecko.strict_min_version, '140.0');
  }

  t.section('dual-build: everything except the manifest is shared');
  {
    for (const k of ['permissions', 'host_permissions', 'content_scripts', 'icons', 'action']) {
      t.deepEq('identical ' + k, ff[k], chrome[k]);
    }
  }
}

module.exports = { run };
