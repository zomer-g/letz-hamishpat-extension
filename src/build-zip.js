#!/usr/bin/env node
// Build a clean, submission-ready package of the extension — for EITHER store,
// from this one source tree.
//
//   node build-zip.js                  → dist/extension-v{version}.zip        (Chrome Web Store)
//   node build-zip.js --target=firefox → dist/firefox-extension-v{version}.zip (AMO)
//                                      + dist/firefox/  (unpacked, for about:debugging)
//
// Only the manifest differs between targets (see toFirefoxManifest); every
// other byte is shared, which is the whole point of keeping one tree.
// Excludes: docs (.md), build script, samples/, dist/, .git, node_modules, source maps.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

const TARGET = (process.argv.find((a) => a.startsWith('--target=')) || '').split('=')[1]
  || (process.argv.includes('--firefox') ? 'firefox' : 'chrome');
if (!['chrome', 'firefox'].includes(TARGET)) {
  console.error(`Unknown --target=${TARGET} (expected chrome|firefox)`);
  process.exit(1);
}

function manifestVersion() {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  return m.version;
}

// Turn the Chrome manifest into the Firefox/AMO one:
//   • background service worker → event-page script (Firefox MV3 has no SW)
//   • browser_specific_settings.gecko — required by AMO:
//       id                          permanent add-on identity
//       strict_min_version 140      the floor for data_collection_permissions
//                                   (world:"MAIN" would only need 128)
//       data_collection_permissions mandatory for new AMO submissions since
//                                   2025-11-03; we collect nothing → "none"
//   • drop `oauth2` — a Chrome-only key; on Firefox the flow runs through
//     identity.launchWebAuthFlow with its own client id (see the service worker)
function toFirefoxManifest(mf) {
  const m = JSON.parse(JSON.stringify(mf));
  if (m.background && m.background.service_worker) {
    m.background = { scripts: [m.background.service_worker] };
  }
  delete m.oauth2;
  delete m.key; // Chrome-only, and dev-only even there — see stripDevOnlyKeys
  m.browser_specific_settings = {
    gecko: {
      id: 'court-downloader@z-g.co.il',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  return m;
}

const EXCLUDES = [
  'dist',
  'samples',
  'marketing',
  'tests',
  'node_modules',
  'package.json',
  'package-lock.json',
  '.git',
  'build-zip.js',
  'STORE_LISTING.md',
  'CWS_DASHBOARD_TEXTS.md',
  'PRIVACY_POLICY.md',
  'REVIEWER_NOTES.md',
  'README.md',
];

function listIncluded() {
  const all = [];
  function walk(rel) {
    const abs = path.join(ROOT, rel);
    for (const name of fs.readdirSync(abs)) {
      const childRel = rel ? path.join(rel, name) : name;
      if (EXCLUDES.includes(childRel) || EXCLUDES.includes(name)) continue;
      const childAbs = path.join(ROOT, childRel);
      const stat = fs.statSync(childAbs);
      if (stat.isDirectory()) {
        walk(childRel);
      } else if (stat.isFile()) {
        // skip stray .md files at any depth
        if (childRel.toLowerCase().endsWith('.md')) continue;
        if (childRel.toLowerCase().endsWith('.map')) continue;
        // skip stray archives (e.g. a protocol download accidentally saved into
        // icons/ — it must never end up inside the extension package)
        if (childRel.toLowerCase().endsWith('.zip')) continue;
        all.push(childRel);
      }
    }
  }
  walk('');
  return all;
}

function ensureDist() {
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
}

// `key` pins the extension ID. It lives in the source manifest so an UNPACKED
// dev load gets the same id as the published item — without it Chrome assigns a
// per-path id, chrome.identity.getAuthToken is called with an id the OAuth
// client was never registered for, and every Drive/Calendar sign-in dies with
// "bad client id". It must NOT ship: the Chrome Web Store assigns identity from
// the item itself, and on Firefox the field is meaningless.
function stripDevOnlyKeys(mf) {
  const m = JSON.parse(JSON.stringify(mf));
  delete m.key;
  return m;
}

// Read a file for packaging — the manifest is transformed for Firefox, every
// other file ships byte-identical to both stores.
function contentFor(rel) {
  if (rel === 'manifest.json') {
    const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const out = TARGET === 'firefox' ? toFirefoxManifest(mf) : stripDevOnlyKeys(mf);
    return Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8');
  }
  return fs.readFileSync(path.join(ROOT, rel));
}

async function makeZip(zipPath, files) {
  // Use the vendored JSZip (Node-compatible UMD) so entry names use FORWARD
  // slashes. PowerShell's Compress-Archive writes back-slash separators on
  // Windows, which the Chrome Web Store and AMO can fail to resolve — icons/
  // and content/ files appear "missing".
  const JSZip = require(path.join(ROOT, 'vendor', 'jszip.min.js'));
  const zip = new JSZip();
  for (const rel of files) {
    zip.file(rel.split(path.sep).join('/'), contentFor(rel)); // normalize \ -> /
  }
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(zipPath, buf);
}

// Firefox's about:debugging loads an unpacked folder, and the transformed
// manifest only exists inside the zip — so mirror the build to dist/firefox/
// to make temporary-install testing a one-click affair.
function writeUnpacked(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const rel of files) {
    const out = path.join(dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, contentFor(rel));
  }
}

async function main() {
  const version = manifestVersion();
  ensureDist();
  const files = listIncluded();
  const name = TARGET === 'firefox' ? `firefox-extension-v${version}.zip` : `extension-v${version}.zip`;
  const zipPath = path.join(DIST, name);
  console.log(`[${TARGET}] packing ${files.length} files into ${path.relative(ROOT, zipPath)}`);
  await makeZip(zipPath, files);
  const size = fs.statSync(zipPath).size;
  console.log(`Built ${path.relative(ROOT, zipPath)} (${(size / 1024).toFixed(1)} KB)`);
  if (TARGET === 'firefox') {
    const unpacked = path.join(DIST, 'firefox');
    writeUnpacked(unpacked, files);
    console.log(`Also wrote ${path.relative(ROOT, unpacked)}/ — load it via about:debugging → Load Temporary Add-on.`);
  }
}

main();
