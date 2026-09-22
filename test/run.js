'use strict';

/**
 * Zero-dependency test runner: node test/run.js [name-filter]
 * Runs every *.test.js in this directory, awaits all tests, exits 1 on failure.
 */
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .filter(f => f.includes(filter));

let passed = 0;
let failed = 0;
const failures = [];
const t0 = Date.now();

const harness = {
  pass(msg) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  },
  fail(msg, err) {
    failed++;
    failures.push({ msg, err: err && err.message });
    console.log(`  \u2717 ${msg}${err ? ` -- ${err.message}` : ''}`);
  },
  suite(name) {
    console.log(`\n${name}`);
  },
};

global.__harness = harness;

(async () => {
  for (const file of files) {
    try {
      require(path.join(__dirname, file));
    } catch (err) {
      harness.fail(`suite load: ${file}`, err);
    }
    // let this file's registered tests settle before loading the next one
    // (keeps per-file timing honest for slow integration suites)
    await Promise.allSettled(require(path.join(__dirname, 'test-harness')).pending.splice(0));
  }

  const ms = Date.now() - t0;
  console.log(`\n${passed} passed, ${failed} failed (${(ms / 1000).toFixed(1)}s)`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.msg}${f.err ? `: ${f.err}` : ''}`);
    process.exit(1);
  }
})();
