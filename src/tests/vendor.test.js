// Vendored third-party libraries — provenance that cannot go stale.
//
// MV3 forbids remote code, so these libraries ship inside the package and AMO
// asks for their sources and for an account of anything we changed. The Firefox
// build renders vendor/VENDOR.json into the reviewer notes; these tests verify
// that record against the files actually on disk, so the notes can never claim
// something the package does not match.
//
// This exists because the reviewer-notes template originally asserted "neither
// library is patched" — which was false. jsPDF carries one deliberate change:
// its remote pdfobject.min.js loader is blanked out.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXT_ROOT } = require('./helpers/env.js');

const VENDOR_DIR = path.join(EXT_ROOT, 'vendor');

// Hash with LF line endings: a Windows checkout can materialise CRLF, which
// changes the bytes without changing a single line of code.
function sha256LF(buf) {
  const norm = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

function run(t) {
  const meta = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'VENDOR.json'), 'utf8'));
  const libs = meta.libraries;
  const onDisk = fs.readdirSync(VENDOR_DIR).filter((f) => f.endsWith('.js')).sort();

  t.section('vendor: every shipped library is documented');
  {
    const undocumented = onDisk.filter((f) => !libs[f]);
    t.eq('no undocumented library', undocumented.join(', '), '');
    const missing = Object.keys(libs).filter((f) => !onDisk.includes(f));
    t.eq('no documented-but-absent library', missing.join(', '), '');
  }

  t.section('vendor: each entry carries what a reviewer needs');
  {
    for (const [file, lib] of Object.entries(libs)) {
      t.ok(file + ' names the library', !!lib.name);
      t.ok(file + ' states a version', /^\d+\.\d+\.\d+$/.test(lib.version || ''));
      t.ok(file + ' links upstream', /^https:\/\//.test(lib.upstream || ''));
      t.ok(file + ' records the upstream hash', /^[0-9a-f]{64}$/.test(lib.upstreamSha256 || ''));
      t.ok(file + ' records the shipped hash', /^[0-9a-f]{64}$/.test(lib.localSha256 || ''));
      t.ok(file + ' declares its modifications', Array.isArray(lib.modifications));
    }
  }

  // The heart of it: the recorded hash must match the file we actually ship, so
  // a library swapped or patched without updating VENDOR.json fails here rather
  // than reaching a reviewer as a false claim.
  t.section('vendor: recorded hashes match the shipped files');
  {
    for (const file of onDisk) {
      const got = sha256LF(fs.readFileSync(path.join(VENDOR_DIR, file)));
      t.eq(file + ' matches its recorded localSha256', got, libs[file].localSha256);
    }
  }

  // An unmodified library must be byte-identical to upstream — that is what
  // "modifications: []" asserts, so prove it rather than trusting the label.
  t.section('vendor: "unmodified" really means identical to upstream');
  {
    for (const [file, lib] of Object.entries(libs)) {
      if (lib.modifications.length) {
        t.ok(file + ' is modified, so its hashes must differ', lib.localSha256 !== lib.upstreamSha256);
        for (const m of lib.modifications) {
          t.ok(file + ' explains the change in usable detail', String(m).length > 60);
        }
      } else {
        t.eq(file + ' is unmodified → hashes identical', lib.localSha256, lib.upstreamSha256);
      }
    }
  }

  // The specific patch, pinned. If someone re-vendors jsPDF from upstream and
  // forgets to strip the loader, the extension would ship remote-code loading —
  // an AMO policy violation and an MV3 one.
  t.section('vendor: jsPDF ships no remote-code loader');
  {
    const src = fs.readFileSync(path.join(VENDOR_DIR, 'jspdf.umd.min.js'), 'utf8');
    t.eq('the cdnjs pdfobject URL is gone', /cdnjs\.cloudflare\.com/.test(src), false);
  }
}

module.exports = { run };
