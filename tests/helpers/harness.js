// Minimal zero-framework assertion harness shared by every *.test.js module.
// Each test file exports `function run(t) {}` and receives this object as `t`.
// The orchestrator (run-tests.js) aggregates the pass/fail counts and sets the
// process exit code.

function createHarness() {
  let pass = 0, fail = 0;
  const failures = [];

  function section(name) { console.log('\n' + name); }

  function ok(name, cond) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; failures.push(name); console.log('  XX  ' + name); }
  }

  function eq(name, actual, expected) {
    ok(name + ' (' + JSON.stringify(actual) + ' === ' + JSON.stringify(expected) + ')', actual === expected);
  }

  function deepEq(name, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    ok(name + (a === b ? '' : ' (' + a + ' !== ' + b + ')'), a === b);
  }

  function throws(name, fn) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    ok(name + ' (throws)', threw);
  }

  function counts() { return { pass, fail, failures: failures.slice() }; }

  return { section, ok, eq, deepEq, throws, counts };
}

module.exports = { createHarness };
