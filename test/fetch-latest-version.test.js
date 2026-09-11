'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const { __test__ } = require('../src/install');
const { fetchLatestVersion } = __test__;

test('fetchLatestVersion resolves null (never throws/rejects) on a request that cannot complete in time', async () => {
  // A 1ms timeout can't complete a real HTTPS round trip, so this deterministically
  // exercises the failure path regardless of whether the sandbox actually has
  // outbound network access at test time.
  const result = await fetchLatestVersion(1);
  assert.equal(result, null);
});

test('fetchLatestVersion never throws on a real request, and resolves a string or null', async () => {
  // Environment-dependent (needs outbound network to succeed), so this only
  // asserts the never-throws contract and the return shape — not that a
  // version is actually returned, which would make the suite flaky offline.
  const result = await fetchLatestVersion(5000);
  assert.ok(result === null || typeof result === 'string', `expected null or string, got ${typeof result}`);
});
