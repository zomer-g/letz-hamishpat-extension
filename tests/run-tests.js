#!/usr/bin/env node
// Test orchestrator. Loads every *.test.js module, runs them against a single
// shared assertion harness, prints an aggregate summary, and sets the process
// exit code (non-zero on any failure) so CI / pre-commit can gate on it.
//
// Run:  node tests/run-tests.js   (or: npm test)

const { createHarness } = require('./helpers/harness.js');

const MODULES = [
  './ics-builder.test.js',
  './csv.test.js',
  './settings.test.js',
  './net-court.test.js',
  './hearings.test.js',
  './judge-bg.test.js',
  './judge-runner.test.js',
  './case-locator.test.js',
  './case-open.test.js',
  './favorites.test.js',
  './misc.test.js',
];

(async () => {
  const t = createHarness();
  for (const rel of MODULES) {
    const mod = require(rel);
    try {
      await mod.run(t);
    } catch (e) {
      t.ok('MODULE ' + rel + ' threw: ' + (e && e.stack || e), false);
    }
  }
  const { pass, fail, failures } = t.counts();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
