'use strict';

// Minimal, dependency-free test runner. Test files call `test(name, fn)` to
// register a case (fn may be sync or async); `run()` executes them in
// registration order and sets a non-zero exit code if any failed.

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      const message = err && err.stack ? err.stack : String(err);
      console.log(
        message
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n')
      );
      failed++;
    }
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

module.exports = { test, run };
