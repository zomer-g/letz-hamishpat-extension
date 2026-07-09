#!/usr/bin/env node
// Build a clean, submission-ready ZIP of the extension.
// Excludes: docs (.md), build script, samples/, dist/, .git, node_modules, source maps.
//
// Run:  node build-zip.js
// Output: dist/extension-v{version}.zip

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

function manifestVersion() {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  return m.version;
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

async function makeZip(zipPath, files) {
  // Use the vendored JSZip (Node-compatible UMD) so entry names use FORWARD
  // slashes. PowerShell's Compress-Archive writes back-slash separators on
  // Windows, which the Chrome Web Store (and "Load unpacked" from a zip) can
  // fail to resolve — icons/ and content/ files appear "missing".
  const JSZip = require(path.join(ROOT, 'vendor', 'jszip.min.js'));
  const zip = new JSZip();
  for (const rel of files) {
    const data = fs.readFileSync(path.join(ROOT, rel));
    zip.file(rel.split(path.sep).join('/'), data); // normalize \ -> /
  }
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(zipPath, buf);
}

async function main() {
  const version = manifestVersion();
  ensureDist();
  const files = listIncluded();
  const zipPath = path.join(DIST, `extension-v${version}.zip`);
  console.log(`Packing ${files.length} files into ${path.relative(ROOT, zipPath)}`);
  await makeZip(zipPath, files);
  const size = fs.statSync(zipPath).size;
  console.log(`Built ${path.relative(ROOT, zipPath)} (${(size / 1024).toFixed(1)} KB)`);
}

main();
