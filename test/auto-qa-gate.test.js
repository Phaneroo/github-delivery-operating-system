'use strict';

// auto-qa-request.yml skips pushes that only touch quiet paths with a
// `paths-ignore` filter (a skipped run bills no Actions minute). The script's
// DEFAULT_QUIET_PATHS is the source of truth, so the filter must list exactly
// those globs or a push the script would file for could be skipped, or the
// saving quietly shrinks.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');
const { DEFAULT_QUIET_PATHS } = require('../.github/scripts/auto-qa-request');

const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'auto-qa-request.yml'), 'utf8');
const block = yml.slice(yml.indexOf('paths-ignore:'), yml.indexOf('permissions:'));
const listed = [...block.matchAll(/^\s+- '([^']+)'/gm)].map((m) => m[1]);

test('auto-qa-request: the push paths-ignore list matches the script\'s default quiet paths', () => {
  assert.deepEqual(listed, DEFAULT_QUIET_PATHS);
});
