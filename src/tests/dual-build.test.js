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

function run(t) {
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

  const ff = firefoxManifest();

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
