'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./harness');
const { runSetupSkill, SKILL_NAME, SKILL_SRC } = require('../src/setup-skill');
const { __test__ } = require('../src/install');

const root = path.join(__dirname, '..');
const skillText = fs.readFileSync(path.join(root, SKILL_SRC), 'utf8');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-os-skill-'));
}
function quietly(fn) {
  const orig = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

test('the setup skill has the right name and a description that says when to use it', () => {
  assert.match(skillText, new RegExp(`^---\\nname: ${SKILL_NAME}\\ndescription: .+\\n---\\n`));
  assert.match(skillText, /delivery-ops/, 'points to the operating skill for repos that already have it');
});

test('every CLI flag and command the setup skill tells Claude to use exists', () => {
  const cli = fs.readFileSync(path.join(root, 'src', 'cli.js'), 'utf8');
  const flags = [...new Set(skillText.match(/--[a-z][a-z-]+/g))];
  for (const flag of flags) {
    assert.ok(cli.includes(flag) || flag === '--json' || flag === '--help', `skill mentions ${flag}, which the CLI doesn't define`);
  }
  assert.ok(cli.includes("command('list')"));
  assert.ok(cli.includes("command('add <packs>") && cli.includes("command('remove <packs>"), 'the skill tells Claude to use add and remove');
  assert.ok(cli.includes("command('status"));
});

test('the workflows and bundles the skill names are real', () => {
  const { WORKFLOWS, BUNDLES } = __test__;
  for (const bundle of ['lite', 'full']) assert.ok(BUNDLES[bundle], bundle);
  for (const name of skillText.match(/`(?:sprint-child-creator|auto-close-sprint|notify-release-approver|authorize-deployment|auto-assign-qa|telegram-issues|setup-labels|auto-qa-request|qa-rollup-approval)`/g) || []) {
    assert.ok(WORKFLOWS.includes(name.replace(/`/g, '')));
  }
});

test('setup-skill installs into the user-level skills folder, once, and says so', () => {
  const home = tmp();
  try {
    quietly(() => runSetupSkill({ homeDir: home }));
    const dest = path.join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md');
    assert.equal(fs.readFileSync(dest, 'utf8'), skillText);
    fs.writeFileSync(dest, 'edited by the user');
    quietly(() => runSetupSkill({ homeDir: home }));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'edited by the user', 'an existing copy is not overwritten without --update');
    quietly(() => runSetupSkill({ homeDir: home, update: true }));
    assert.equal(fs.readFileSync(dest, 'utf8'), skillText);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup-skill --project writes into the repo, and --dry-run writes nothing', () => {
  const repo = tmp();
  const home = tmp();
  try {
    quietly(() => runSetupSkill({ project: true, dryRun: true, cwd: repo, homeDir: home }));
    assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
    quietly(() => runSetupSkill({ project: true, cwd: repo, homeDir: home }));
    assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', SKILL_NAME, 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'the user-level folder is untouched');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the setup skill ships in the npm package', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.files.includes('skills/delivery-os-setup'));
});
