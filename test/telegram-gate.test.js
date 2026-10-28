'use strict';

// telegram-issues.yml's job-level `if:` skips events the script can't send a
// message for (a skipped job bills no Actions minutes). The two are separate
// lists, so check they can't drift: every label the script reacts to must also
// get past the gate.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');

const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'telegram-issues.yml'), 'utf8');
const gate = yml.slice(yml.indexOf('    if: >-'), yml.indexOf('    runs-on:'));
const script = yml.slice(yml.indexOf('run: |'));
const labelsIn = (text) => new Set([...text.matchAll(/labels\.\*\.name \|\| fromJSON\('\[\]'\), '([\w-]+)'\)/g)].map((m) => m[1]));

test('telegram-issues: every label the script reports on passes the job-level gate', () => {
  const inGate = labelsIn(gate);
  const missing = [...labelsIn(script)].filter((l) => !inGate.has(l));
  assert.deepEqual(missing, [], `script handles these labels but the job-level if: would skip them: ${missing}`);
});
