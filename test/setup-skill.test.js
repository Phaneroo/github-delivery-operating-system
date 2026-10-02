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
  assert.ok(cli.includes("command('list"));
  assert.ok(cli.includes("command('add <names>") && cli.includes("command('remove <names>"), 'the skill tells Claude to use add and remove');
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

// ---- the two skills behave as one assistant ----

const opsText = fs.readFileSync(path.join(root, '.claude', 'skills', 'delivery-ops', 'SKILL.md'), 'utf8');
const addendumText = fs.readFileSync(path.join(root, '.github', 'lite', 'skill-addendum.md'), 'utf8');
const description = (text) => (text.match(/^description: (.+)$/m) || [])[1] || '';
const opsSection = () => {
  const i = opsText.indexOf("## Changing what's installed");
  return opsText.slice(i, opsText.indexOf('\n## ', i + 5));
};

test("delivery-ops owns changing what's installed, for full and lite, and says when to use it", () => {
  assert.equal(opsText.split("## Changing what's installed").length, 2, 'exactly one such section');
  assert.ok(opsText.indexOf("## Changing what's installed") < opsText.indexOf('## Creating issues'));
  assert.match(description(opsText), /turn a piece on or off|what is installed/i);
  const section = opsSection();
  for (const needle of ['list .', 'add <names>', 'remove <names>', '--dry-run', 'telegram', 'qa', 'QA_APPROVER', 'TELEGRAM_BOT_TOKEN', 'delivery-os-setup']) {
    assert.ok(section.includes(needle), `the section should mention ${needle}`);
  }
});

test('every flag and command in delivery-ops\'s changing-what\'s-installed section exists in the CLI', () => {
  const cli = fs.readFileSync(path.join(root, 'src', 'cli.js'), 'utf8');
  for (const flag of new Set(opsSection().match(/--[a-z][a-z-]+/g))) assert.ok(cli.includes(flag), flag);
  assert.ok(cli.includes("command('add <names>") && cli.includes("command('remove <names>") && cli.includes("command('list"));
});

test('the setup skill is first-time only, points to delivery-ops for everything after, and hands over at the end', () => {
  const desc = description(skillText);
  assert.match(desc, /First-time setup/);
  assert.match(desc, /delivery-ops/);
  assert.match(skillText, /front door, used once/);
  assert.match(skillText, /Hand over\./);
  assert.match(skillText, /\.claude\/skills\/delivery-ops/, 'it checks whether the repo skill is there before deciding');
  assert.match(skillText, /--with-skill\` \(recommended\)/, 'it recommends the repo skill to Claude Code users');
});

test('neither skill sends the other\'s work back and forth: setup defers installed repos, ops defers empty ones', () => {
  assert.match(skillText, /Installed, and `\.claude\/skills\/delivery-ops` is in the repo/);
  assert.match(opsText, /No Delivery OS in the repo yet\?/);
});

test('the lite delivery-ops skill is the shared skill plus an addendum that points at the shared section, not a second copy of it', () => {
  assert.doesNotMatch(addendumText, /Adding and removing is cheap/);
  assert.match(addendumText, /Changing what's installed/);
  const { skillForBundle, SKILL_ANCHOR } = __test__;
  const lite = skillForBundle(opsText, path.join(root, '.github', 'lite', 'skill-addendum.md'));
  assert.equal(lite.split("## Changing what's installed").length - 1, 1, 'the section itself appears once, not copied into the addendum');
  assert.ok(lite.split("Changing what's installed").length - 1 >= 2, 'and the addendum points at it');
  assert.ok(lite.indexOf('## Which install is this?') < lite.indexOf(SKILL_ANCHOR));
  assert.ok(lite.indexOf(SKILL_ANCHOR) < lite.indexOf("\n## Changing what's installed"));
});
