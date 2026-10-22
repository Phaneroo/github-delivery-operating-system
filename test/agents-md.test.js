'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./harness');
const { runInstall, runUninstall } = require('../src/install');
const { BEGIN, END, agentsSection } = require('../src/agents-md');

const skillText = fs.readFileSync(path.join(__dirname, '..', '.claude', 'skills', 'delivery-ops', 'SKILL.md'), 'utf8');

function inRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-os-agents-'));
  const cwd = process.cwd();
  const log = console.log;
  console.log = () => {};
  try {
    process.chdir(dir);
    fn(dir, path.join(dir, 'AGENTS.md'));
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the AGENTS.md section is the skill without Claude-only wording or frontmatter', () => {
  const section = agentsSection(skillText);
  assert.ok(section.startsWith(BEGIN) && section.trimEnd().endsWith(END));
  assert.doesNotMatch(section, /Claude/);
  assert.doesNotMatch(section, /^name: delivery-ops/m);
  assert.match(section, /## Pre-flight check/);
  assert.match(section, /### Field Label|`### <Field Label>`/);
});

test('--with-agents creates AGENTS.md; a second plain run leaves it, --update refreshes it', () => {
  inRepo((dir, file) => {
    runInstall({ targetDir: '.', withAgents: true });
    assert.match(fs.readFileSync(file, 'utf8'), /Operate Delivery OS/);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Do one step', 'EDITED step'));
    runInstall({ targetDir: '.', withAgents: true });
    assert.match(fs.readFileSync(file, 'utf8'), /EDITED step/, 'kept without --update');
    runInstall({ targetDir: '.', withAgents: true, overwrite: true });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /EDITED step/);
  });
});

test('an existing AGENTS.md keeps its own text, and uninstall removes only our section', () => {
  inRepo((dir, file) => {
    fs.writeFileSync(file, '# Project rules\n\nUse tabs.\n');
    runInstall({ targetDir: '.', withAgents: true });
    runInstall({ targetDir: '.', withAgents: true, overwrite: true });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^# Project rules\n\nUse tabs\./);
    assert.equal(text.split(BEGIN).length, 2, 'one block only after a refresh');
    runUninstall({ targetDir: '.', withAgents: true });
    assert.equal(fs.readFileSync(file, 'utf8'), '# Project rules\n\nUse tabs.\n');
  });
});

test('uninstall deletes an AGENTS.md that held only our section; --dry-run touches nothing', () => {
  inRepo((dir, file) => {
    runInstall({ targetDir: '.', withAgents: true, dryRun: true });
    assert.ok(!fs.existsSync(file));
    runInstall({ targetDir: '.', withAgents: true });
    runUninstall({ targetDir: '.', withAgents: true, dryRun: true });
    assert.ok(fs.existsSync(file));
    runUninstall({ targetDir: '.', withAgents: true });
    assert.ok(!fs.existsSync(file));
  });
});

test('a lite install gets the lite addendum in the AGENTS.md section; full does not', () => {
  inRepo((dir, file) => {
    runInstall({ targetDir: '.', withAgents: true, bundle: 'lite' });
    const lite = fs.readFileSync(file, 'utf8');
    assert.match(lite, /## Which install is this\? \(full or lite\)/);
    assert.doesNotMatch(lite, /Claude/);
    fs.unlinkSync(file);
    fs.rmSync(path.join(dir, '.github'), { recursive: true, force: true });
    runInstall({ targetDir: '.', withAgents: true });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Which install is this\?/);
  });
});
