'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('./harness');
const { runInstall, runStatus, runUninstall, __test__ } = require('../src/install');
const {
  manifestPath,
  readManifest,
  writeManifest,
  buildUpdateCommand,
  skillPath,
  SKILL_REL_PATH,
  WORKFLOWS,
  TEMPLATES,
  SCRIPTS,
  SCRIPTS_PACKAGE_JSON,
  loadLabels,
} = __test__;

const packageRoot = path.join(__dirname, '..');

const pkgVersion = require('../package.json').version;

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-os-test-'));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Runs fn with cwd switched to `dir` and console.log suppressed (install/
// uninstall are noisy by design; tests assert on the filesystem, not output).
function inRepoQuietly(dir, fn) {
  const origCwd = process.cwd();
  const origLog = console.log;
  console.log = () => {};
  try {
    process.chdir(dir);
    return fn();
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
  }
}

test('readManifest returns null when no manifest exists', () => {
  const dir = mkTmpRepo();
  try {
    assert.equal(readManifest(dir), null);
  } finally {
    rm(dir);
  }
});

test('writeManifest + readManifest round-trip', () => {
  const dir = mkTmpRepo();
  try {
    writeManifest(dir, '9.9.9');
    const manifest = readManifest(dir);
    assert.equal(manifest.version, '9.9.9');
    assert.equal(typeof manifest.installedAt, 'string');
    assert.ok(fs.existsSync(manifestPath(dir)));
  } finally {
    rm(dir);
  }
});

test('readManifest returns null for corrupt JSON instead of throwing', () => {
  const dir = mkTmpRepo();
  try {
    fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
    fs.writeFileSync(manifestPath(dir), 'not json');
    assert.equal(readManifest(dir), null);
  } finally {
    rm(dir);
  }
});

test('fresh install writes a manifest matching the current package version', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    const manifest = readManifest(dir);
    assert.ok(manifest, 'expected a manifest to be written');
    assert.equal(manifest.version, pkgVersion);

    const workflowsDest = path.join(dir, '.github', 'workflows');
    const templatesDest = path.join(dir, '.github', 'ISSUE_TEMPLATE');
    const scriptsDest = path.join(dir, '.github', 'scripts');
    for (const wf of WORKFLOWS) {
      assert.ok(fs.existsSync(path.join(workflowsDest, `${wf}.yml`)), `missing ${wf}.yml`);
    }
    for (const t of TEMPLATES) {
      assert.ok(fs.existsSync(path.join(templatesDest, t)), `missing template ${t}`);
    }
    // Regression guard: these three workflows require() these scripts at
    // runtime (see .github/workflows/*.yml). A published package that
    // shipped the workflows without them installed correctly here but
    // crashed with MODULE_NOT_FOUND the first time one of those workflows
    // actually ran on GitHub Actions — install() reported success while
    // producing a broken install. Confirmed live on the published 1.1.0/
    // 1.2.0 packages before this test existed.
    for (const name of SCRIPTS) {
      assert.ok(fs.existsSync(path.join(scriptsDest, `${name}.js`)), `missing .github/scripts/${name}.js`);
    }
    // Regression guard: a consumer repo whose own package.json has
    // "type": "module" makes Node treat every .js file as an ES module by
    // default, including these CommonJS scripts — breaking require() with
    // "module is not defined in ES module scope" the moment a workflow
    // actually runs. Confirmed live against a real "type": "module" repo
    // before this file (and this test) existed. This package.json pins
    // .github/scripts to CommonJS regardless of the consumer's own type field.
    const scriptsPkgPath = path.join(scriptsDest, SCRIPTS_PACKAGE_JSON);
    assert.ok(fs.existsSync(scriptsPkgPath), `missing .github/scripts/${SCRIPTS_PACKAGE_JSON}`);
    assert.equal(JSON.parse(fs.readFileSync(scriptsPkgPath, 'utf8')).type, 'commonjs');
  } finally {
    rm(dir);
  }
});

test('skip-mode install over existing files does not overwrite a stale recorded version', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    writeManifest(dir, '0.0.1'); // simulate a repo left behind on an old version
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true })); // skip-mode: files already exist
    const manifest = readManifest(dir);
    assert.equal(manifest.version, '0.0.1', 'skip-mode install must not claim a version that is not really on disk');
  } finally {
    rm(dir);
  }
});

test('--overwrite install syncs the manifest to the current package version', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    writeManifest(dir, '0.0.1');
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, overwrite: true }));
    const manifest = readManifest(dir);
    assert.equal(manifest.version, pkgVersion);
  } finally {
    rm(dir);
  }
});

test('--overwrite without --with-templates does not claim clean install while stale templates remain untouched', () => {
  // Regression guard: `overwrite || (skip counters all zero)` used to treat
  // ANY --overwrite run as fully clean, even when templates/skill already on
  // disk from an earlier install were never touched this run because their
  // flags weren't passed — status would then report "up to date" for files
  // that were, in fact, still at the old version.
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true })); // templates installed at current version
    writeManifest(dir, '0.0.1'); // simulate: this repo is recorded as being on an old version
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', overwrite: true })); // overwrite workflows only — no --with-templates
    const manifest = readManifest(dir);
    assert.equal(
      manifest.version,
      '0.0.1',
      'must not claim clean when pre-existing templates were not touched by this --overwrite run'
    );
  } finally {
    rm(dir);
  }
});

test('--overwrite without --with-skill does not claim clean install while a stale skill file remains untouched', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    writeManifest(dir, '0.0.1');
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, overwrite: true })); // no --with-skill this time
    const manifest = readManifest(dir);
    assert.equal(manifest.version, '0.0.1');
  } finally {
    rm(dir);
  }
});

test('--overwrite still claims a clean install when nothing pre-existing is left untouched', () => {
  const dir = mkTmpRepo();
  try {
    // Nothing pre-exists here — templates/skill were never installed before,
    // so their absence must not block a clean-install claim.
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, overwrite: true }));
    const manifest = readManifest(dir);
    assert.equal(manifest.version, pkgVersion);
  } finally {
    rm(dir);
  }
});

test('dry-run install does not write a manifest or any files', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, dryRun: true }));
    assert.equal(readManifest(dir), null);
    assert.equal(fs.existsSync(path.join(dir, '.github', 'workflows')), false);
  } finally {
    rm(dir);
  }
});

test('uninstall removes the manifest along with workflows/templates', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    assert.ok(readManifest(dir));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true }));
    assert.equal(readManifest(dir), null);
    assert.equal(
      fs.existsSync(path.join(dir, '.github', 'workflows', 'sprint-child-creator.yml')),
      false
    );
  } finally {
    rm(dir);
  }
});

test('uninstall without --with-templates keeps the manifest when templates remain fully present', () => {
  // Regression guard: the manifest used to be removed unconditionally, even
  // when templates were deliberately kept (no --with-templates on uninstall)
  // — a later status would then report "unknown version" for templates that
  // were, in fact, still completely present and accurately version-tracked.
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.' })); // no --with-templates: templates kept
    assert.ok(readManifest(dir), 'manifest should survive since templates are still fully present');
    for (const t of TEMPLATES) {
      assert.ok(fs.existsSync(path.join(dir, '.github', 'ISSUE_TEMPLATE', t)));
    }
  } finally {
    rm(dir);
  }
});

test('uninstall removes the manifest once nothing Delivery-OS-related actually remains', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    assert.equal(readManifest(dir), null);
  } finally {
    rm(dir);
  }
});

test('uninstall removes the CommonJS-pinning scripts/package.json', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    const scriptsPkgPath = path.join(dir, '.github', 'scripts', SCRIPTS_PACKAGE_JSON);
    assert.ok(fs.existsSync(scriptsPkgPath));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true }));
    assert.equal(fs.existsSync(scriptsPkgPath), false);
  } finally {
    rm(dir);
  }
});

test('uninstall dry-run does not delete anything', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true, dryRun: true }));
    assert.ok(readManifest(dir), 'manifest should survive a dry-run uninstall');
    assert.ok(
      fs.existsSync(path.join(dir, '.github', 'workflows', 'sprint-child-creator.yml')),
      'workflow file should survive a dry-run uninstall'
    );
  } finally {
    rm(dir);
  }
});

test('status (checkUpdates: false) reports installed workflows without network access', async () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, /Installed version:/);
    assert.match(output, new RegExp(`7\\/${WORKFLOWS.length} workflows`));
    assert.doesNotMatch(output, /Update available|Up to date|Could not check npm/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('loadLabels reads the single-source-of-truth .github/scripts/labels.js, not a separate hardcoded copy', () => {
  // Regression guard for the exact bug this replaced: src/install.js used to
  // keep its own independent LABELS array that silently drifted out of sync
  // with setup-labels.yml and scripts/install.sh (see issue #20). Asserting
  // against the shared file directly proves install.js is actually reading
  // it, not just returning a coincidentally-similar array of its own.
  const labels = loadLabels(packageRoot);
  const fromFileDirectly = require(path.join(packageRoot, '.github', 'scripts', 'labels.js')).LABELS;
  assert.equal(labels, fromFileDirectly, 'loadLabels must return the exact same array the shared file exports');

  assert.ok(Array.isArray(labels) && labels.length > 0);
  for (const entry of labels) {
    assert.ok(Array.isArray(entry) && entry.length >= 2, `malformed label entry: ${JSON.stringify(entry)}`);
    const [name, color, description] = entry;
    assert.equal(typeof name, 'string');
    assert.match(color, /^[0-9A-Fa-f]{6}$/, `${name}: color must be a 6-digit hex code`);
    if (description !== undefined) {
      assert.equal(typeof description, 'string');
      assert.ok(description.length <= 100, `${name}: GitHub label descriptions are capped at 100 chars`);
    }
  }

  const sprintChild = labels.find(([name]) => name === 'sprint-child');
  assert.ok(sprintChild, 'sprint-child label must be defined');
  assert.ok(sprintChild[2], 'sprint-child must carry a description explaining it predates sprint closure');
});

test('buildUpdateCommand includes --with-templates/--with-skill only when those are actually installed', () => {
  assert.equal(
    buildUpdateCommand({ hasTemplates: false, hasSkill: false }),
    'npx github-delivery-os@latest install --update .'
  );
  assert.equal(
    buildUpdateCommand({ hasTemplates: true, hasSkill: false }),
    'npx github-delivery-os@latest install --with-templates --update .'
  );
  assert.equal(
    buildUpdateCommand({ hasTemplates: false, hasSkill: true }),
    'npx github-delivery-os@latest install --with-skill --update .'
  );
  assert.equal(
    buildUpdateCommand({ hasTemplates: true, hasSkill: true }),
    'npx github-delivery-os@latest install --with-templates --with-skill --update .'
  );
});

test('status\'s "unknown version" hint includes --with-templates/--with-skill when those are installed (regression: bare --update left them stale forever)', async () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    // Simulate "installed before version tracking was added": files on
    // disk, no manifest.
    fs.rmSync(manifestPath(dir));

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, /Installed version: unknown/);
    // The bug: this hint used to always suggest a bare `install --update`,
    // which for a repo with templates/skill already installed leaves them
    // present-but-untouched — runInstall's cleanInstall check then refuses
    // to record a version at all, so status loops on the same broken
    // suggestion forever. The hint must name both flags here.
    assert.match(output, /Run: npx github-delivery-os@latest install --with-templates --with-skill --update \./);

    // Prove the suggested command is actually a clean install, not just
    // right-looking text.
    inRepoQuietly(dir, () =>
      runInstall({ targetDir: '.', withTemplates: true, withSkill: true, overwrite: true })
    );
    const manifest = readManifest(dir);
    assert.equal(manifest.version, pkgVersion, 'the suggested command must record a version');
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('--with-skill copies the delivery-ops Claude Code skill', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    assert.ok(fs.existsSync(skillPath(dir)), `expected ${SKILL_REL_PATH} to exist`);
    const content = fs.readFileSync(skillPath(dir), 'utf8');
    assert.match(content, /^---\nname: delivery-ops/);
  } finally {
    rm(dir);
  }
});

test('install without --with-skill does not create the skill file (opt-in, not default)', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    assert.equal(fs.existsSync(skillPath(dir)), false);
  } finally {
    rm(dir);
  }
});

test('skip-mode --with-skill install leaves an existing skill file untouched', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    fs.mkdirSync(path.dirname(skillPath(dir)), { recursive: true });
    fs.writeFileSync(skillPath(dir), 'custom local edits');
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true })); // skip-mode
    assert.equal(fs.readFileSync(skillPath(dir), 'utf8'), 'custom local edits');
  } finally {
    rm(dir);
  }
});

test('--with-skill --overwrite replaces an existing skill file', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    fs.writeFileSync(skillPath(dir), 'stale content');
    inRepoQuietly(dir, () =>
      runInstall({ targetDir: '.', withTemplates: true, withSkill: true, overwrite: true })
    );
    assert.notEqual(fs.readFileSync(skillPath(dir), 'utf8'), 'stale content');
  } finally {
    rm(dir);
  }
});

test('dry-run --with-skill does not create the skill file', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () =>
      runInstall({ targetDir: '.', withTemplates: true, withSkill: true, dryRun: true })
    );
    assert.equal(fs.existsSync(skillPath(dir)), false);
  } finally {
    rm(dir);
  }
});

test('a skipped skill file (while everything else is clean) still blocks the recorded version from updating', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    writeManifest(dir, '0.0.1');
    fs.writeFileSync(skillPath(dir), 'local edits that must not be clobbered');
    // Everything else would be a "clean" skip-free install except the skill file already exists.
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    const manifest = readManifest(dir);
    assert.equal(manifest.version, '0.0.1', 'a skipped skill file must count toward "not a clean install"');
  } finally {
    rm(dir);
  }
});

test('uninstall without --with-skill keeps the skill file', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true }));
    assert.ok(fs.existsSync(skillPath(dir)), 'skill file should survive uninstall without --with-skill');
  } finally {
    rm(dir);
  }
});

test('uninstall --with-skill removes the skill file', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    assert.equal(fs.existsSync(skillPath(dir)), false);
  } finally {
    rm(dir);
  }
});

test('status reports the skill as installed or not', async () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, /✓ delivery-ops/);
    assert.match(output, /skill: yes/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('status reports the skill as missing when not installed', async () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true })); // no --with-skill

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, /delivery-ops \(not installed/);
    assert.match(output, /skill: no/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('status detects a workflow whose required script is missing', async () => {
  // Regression guard for the missing-.github/scripts bug: reproduces the
  // exact broken state that shipped in 1.1.0/1.2.0 (workflow present,
  // required script absent) and confirms status actually flags it instead
  // of silently reporting a clean install.
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    fs.unlinkSync(path.join(dir, '.github', 'scripts', 'auto-close-sprint.js'));

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, /Broken install detected/);
    assert.match(output, /auto-close-sprint\.yml requires \.github\/scripts\/auto-close-sprint\.js/);
    // Regression: this "Fix:" hint must also carry --with-templates when
    // templates are installed, same bug as the version hints (see
    // buildUpdateCommand test) — a bare --update here would leave
    // templates present-but-untouched and never advance the recorded version.
    assert.match(output, /Fix: npx github-delivery-os@latest install --with-templates --update \./);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('status flags a missing scripts/package.json as a broken install', async () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    fs.unlinkSync(path.join(dir, '.github', 'scripts', SCRIPTS_PACKAGE_JSON));

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, new RegExp(`\\.github/scripts/${SCRIPTS_PACKAGE_JSON} is missing`));
    assert.match(output, /Fix: npx github-delivery-os@latest install --with-templates --update \./);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('status reports no broken-install warning when all required scripts are present', async () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);
    assert.doesNotMatch(lines.join('\n'), /Broken install detected/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('status reports installed when only the Claude Code skill is present', async () => {
  // Regression guard: the "is anything installed" checks used to ignore
  // skillInstalled entirely, so a repo with only the skill present (no
  // workflows/templates) would incorrectly report "not installed" and never
  // show the skill line.
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true })); // removes workflows+templates, keeps skill

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.doesNotMatch(output, /not installed/i);
    assert.match(output, /✓ delivery-ops/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('the CLI\'s --overwrite still works as a hidden alias for --update (pre-1.5.0 scripts/CI must not break)', () => {
  // Exercises the real src/cli.js commander parsing (every other test here
  // calls runInstall() directly, bypassing it) since that's the layer that
  // actually defines --overwrite as a hidden Option — a unit test against
  // runInstall alone can't catch a regression here.
  const dir = mkTmpRepo();
  const binPath = path.join(__dirname, '..', 'bin', 'delivery-os.js');
  try {
    const help = execFileSync('node', [binPath, 'install', '--help'], { encoding: 'utf8' });
    assert.match(help, /-u, --update/, 'the new flag name must be documented in --help');
    assert.doesNotMatch(help, /--overwrite/, 'the deprecated alias must stay hidden from --help');

    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'sprint-child-creator.yml'), 'stale content');
    execFileSync('node', [binPath, 'install', '--overwrite', dir], { encoding: 'utf8' });
    assert.notEqual(
      fs.readFileSync(path.join(dir, '.github', 'workflows', 'sprint-child-creator.yml'), 'utf8'),
      'stale content',
      '--overwrite must still actually replace existing files, same as --update'
    );
  } finally {
    rm(dir);
  }
});

test('scripts/install.sh copies every entry in SCRIPTS, including labels.js, not just the JS installer\'s copy', () => {
  // Regression guard: src/install.js's SCRIPTS array and scripts/install.sh's
  // bash SCRIPTS variable are two independent lists with no compiler tie
  // between them (see #20's own lesson). An earlier draft of this PR updated
  // src/install.js to add 'labels' but not the bash script, which would have
  // shipped a setup-labels.yml that MODULE_NOT_FOUNDs on every consumer who
  // installs via scripts/install.sh instead of npx — caught by code review,
  // not by any existing test, since no test exercised scripts/install.sh at
  // all before this one. Asserts against SCRIPTS itself (not a second
  // hardcoded list in this test) so it can't silently drift the same way.
  const dir = mkTmpRepo();
  const installShPath = path.join(__dirname, '..', 'scripts', 'install.sh');
  try {
    execFileSync('bash', [installShPath, '--with-templates', dir], { encoding: 'utf8' });
    for (const name of SCRIPTS) {
      assert.ok(
        fs.existsSync(path.join(dir, '.github', 'scripts', `${name}.js`)),
        `scripts/install.sh did not copy .github/scripts/${name}.js`
      );
    }
  } finally {
    rm(dir);
  }
});

test('status on an empty repo reports not installed, without throwing', async () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    assert.match(lines.join('\n'), /not installed/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});
