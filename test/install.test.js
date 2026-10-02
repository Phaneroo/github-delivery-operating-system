'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('./harness');
const { runInstall, runStatus, runUninstall, runList, __test__ } = require('../src/install');
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
  LABELS_TSV,
  setupLabelsMissingFiles,
  loadLabels,
  BUNDLES,
  manifestBundle,
  REQUIRED_SCRIPT_BY_WORKFLOW,
  resolveSelection,
  parseNameList,
  manifestWorkflows,
  scriptsForWorkflows,
  WORKFLOW_INFO,
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
    // Regression guard: labels.js (in SCRIPTS above) is only a parser —
    // without its sibling data file labels.tsv also landing on disk,
    // setup-labels.yml's require() would MODULE_NOT_FOUND at runtime.
    assert.ok(fs.existsSync(path.join(scriptsDest, LABELS_TSV)), `missing .github/scripts/${LABELS_TSV}`);
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
    assert.match(output, new RegExp(`${WORKFLOWS.length}\\/${WORKFLOWS.length} workflows`));
    assert.doesNotMatch(output, /Update available|Up to date|Could not check npm/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('loadLabels reads the single-source-of-truth .github/scripts/labels.tsv, not a separate hardcoded copy', () => {
  // Regression guard for the exact bug this replaced: src/install.js used to
  // keep its own independent LABELS array that silently drifted out of sync
  // with setup-labels.yml and scripts/install.sh (see issue #20). Asserting
  // against the shared parser+data directly proves install.js is actually
  // reading them, not just returning a coincidentally-similar array of its
  // own.
  const labels = loadLabels(packageRoot);
  const scriptsDir = path.join(packageRoot, '.github', 'scripts');
  const fromFileDirectly = require(path.join(scriptsDir, 'labels.js')).readLabels(scriptsDir);
  assert.deepEqual(labels, fromFileDirectly, 'loadLabels must return what the shared parser produces from labels.tsv');

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

test('readLabels throws (rather than returning something silently wrong) when labels.tsv is missing', () => {
  // The try/catch around loadLabels() in runInstall (and the equivalent
  // try/catch in setup-labels.yml's inline script) relies on this throwing
  // — proves the contract that fix depends on, without needing to exercise
  // the full gh-authenticated --with-labels path to reach it.
  const dir = mkTmpRepo();
  try {
    const scriptsDir = path.join(packageRoot, '.github', 'scripts');
    const { readLabels } = require(path.join(scriptsDir, 'labels.js'));
    assert.throws(() => readLabels(dir), /ENOENT/);
  } finally {
    rm(dir);
  }
});

test('buildUpdateCommand includes --with-templates/--with-skill only when those are actually installed, but always includes --with-labels', () => {
  assert.equal(
    buildUpdateCommand({ hasTemplates: false, hasSkill: false }),
    'npx github-delivery-os@latest install --with-labels --update .'
  );
  assert.equal(
    buildUpdateCommand({ hasTemplates: true, hasSkill: false }),
    'npx github-delivery-os@latest install --with-templates --with-labels --update .'
  );
  assert.equal(
    buildUpdateCommand({ hasTemplates: false, hasSkill: true }),
    'npx github-delivery-os@latest install --with-skill --with-labels --update .'
  );
  assert.equal(
    buildUpdateCommand({ hasTemplates: true, hasSkill: true }),
    'npx github-delivery-os@latest install --with-templates --with-skill --with-labels --update .'
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
    assert.match(
      output,
      /Run: npx github-delivery-os@latest install --with-templates --with-skill --with-labels --update \./
    );

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
    assert.match(output, /Fix: npx github-delivery-os@latest install --with-templates --with-labels --update \./);
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
    assert.match(output, /Fix: npx github-delivery-os@latest install --with-templates --with-labels --update \./);
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

test('status does not false-positive flag a pre-1.5.1 install (setup-labels.yml with no labels.js/labels.tsv) as broken', async () => {
  // Regression guard: an earlier commit on this branch added
  // REQUIRED_SCRIPT_BY_WORKFLOW['setup-labels'] = 'labels' without accounting
  // for setup-labels.yml having required no script at all before this
  // release — every repo that installed it pre-1.5.1 would have been
  // false-positive flagged "Broken install detected" the moment that map
  // entry shipped, even though their actually-installed workflow requires
  // nothing and works fine. Caught by code review before merge. Simulates a
  // pre-1.5.1 install by copying only the workflow file, the way an old
  // install genuinely would have it on disk.
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'setup-labels.yml'),
      '# pre-1.5.1 self-contained setup-labels.yml (no require(), no checkout step)'
    );

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.doesNotMatch(output, /Broken install detected/);
    assert.doesNotMatch(output, /labels\.js|labels\.tsv/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

test('status DOES flag a genuinely broken 1.5.1+ install (workflow content requires labels.js, which is missing) — independent of manifest state', async () => {
  // The other half of the false-positive fix above: never detecting a real
  // break would be just as wrong as false-positiving old installs. An
  // earlier version of this check compared the manifest's recorded version
  // against 1.5.1 — reverted (see setupLabelsMissingFiles's own comment)
  // because the manifest can be stale relative to what's actually on disk.
  // This test deliberately has NO manifest at all, to prove detection
  // doesn't depend on it: what matters is the installed workflow file's own
  // content.
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'setup-labels.yml'),
      "require(`${process.env.GITHUB_WORKSPACE}/.github/scripts/labels.js`)"
    );
    // Deliberately no manifest and no .github/scripts/labels.js on disk.

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, /Broken install detected/);
    assert.match(output, /setup-labels\.yml requires \.github\/scripts\/labels\.js and \.github\/scripts\/labels\.tsv, which are missing/);
  } finally {
    console.log = origLog;
    rm(dir);
  }
});

async function statusOutputWithNotifyWorkflow(content, withScript, withAutoQa = withScript) {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'notify-release-approver.yml'), content);
    fs.mkdirSync(path.join(dir, '.github', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'scripts', 'package.json'), '{"type":"commonjs"}');
    if (withScript) fs.writeFileSync(path.join(dir, '.github', 'scripts', 'release-rollup.js'), '');
    if (withAutoQa) fs.writeFileSync(path.join(dir, '.github', 'scripts', 'auto-qa-request.js'), '');

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);
    return lines.join('\n');
  } finally {
    console.log = origLog;
    rm(dir);
  }
}

test('status does not flag an older notify-release-approver.yml (no release roll-up) as broken', async () => {
  const output = await statusOutputWithNotifyWorkflow('# pre-roll-up notify workflow, requires no script', false);
  assert.doesNotMatch(output, /Broken install detected/);
  assert.doesNotMatch(output, /release-rollup\.js/);
});

test('status flags a notify-release-approver.yml that requires release-rollup.js when it is missing', async () => {
  const output = await statusOutputWithNotifyWorkflow("require(`${process.env.GITHUB_WORKSPACE}/.github/scripts/release-rollup.js`)", false);
  assert.match(output, /Broken install detected/);
  assert.match(output, /release-rollup\.js/);
});

test('status flags a roll-up notify-release-approver.yml whose auto-qa-request.js (rolling checklist parser) is missing', async () => {
  const output = await statusOutputWithNotifyWorkflow("require('.github/scripts/release-rollup.js')", true, false);
  assert.match(output, /Broken install detected/);
  assert.match(output, /auto-qa-request\.js/);
});

test('status is happy with a notify-release-approver.yml whose release-rollup.js is present', async () => {
  const output = await statusOutputWithNotifyWorkflow("require('.github/scripts/release-rollup.js')", true);
  assert.doesNotMatch(output, /Broken install detected/);
});

test('status names the actually-missing file, not always "labels.js" (labels.js present, only labels.tsv missing)', async () => {
  // Regression guard: an earlier version of this check ORed together
  // "script missing" and "data file missing" but only ever logged
  // "labels.js" — wrong when labels.js is right there and labels.tsv is
  // the one actually absent.
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.github', 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'setup-labels.yml'),
      "require(`${process.env.GITHUB_WORKSPACE}/.github/scripts/labels.js`)"
    );
    fs.writeFileSync(path.join(dir, '.github', 'scripts', 'labels.js'), 'module.exports = { readLabels() {} };');
    // Deliberately no labels.tsv.

    console.log = (...args) => lines.push(args.join(' '));
    const origCwd = process.cwd();
    process.chdir(dir);
    await runStatus({ targetDir: '.', checkUpdates: false });
    process.chdir(origCwd);

    const output = lines.join('\n');
    assert.match(output, /Broken install detected/);
    assert.match(output, /setup-labels\.yml requires \.github\/scripts\/labels\.tsv, which is missing/);
    assert.doesNotMatch(output, /requires \.github\/scripts\/labels\.js,/, 'must not falsely name labels.js as missing when it is present');
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
    // labels.js is only a parser — labels.tsv (the actual data) must also
    // be copied, or setup-labels.yml's require() MODULE_NOT_FOUNDs on the
    // data file even with the parser present.
    assert.ok(
      fs.existsSync(path.join(dir, '.github', 'scripts', LABELS_TSV)),
      `scripts/install.sh did not copy .github/scripts/${LABELS_TSV}`
    );
  } finally {
    rm(dir);
  }
});

// A minimal `gh` stub on its own PATH dir, so scripts/install.sh --with-labels
// can be exercised as a real subprocess without hitting the network or a real
// GitHub repo. `behavior` is the body of the `gh label create` branch only —
// auth status/repo view always succeed, everything else exits 0.
function mkFakeGh(behavior) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/usr/bin/env bash\n` +
      `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi\n` +
      `if [ "$1" = "repo" ] && [ "$2" = "view" ]; then exit 0; fi\n` +
      `if [ "$1" = "label" ] && [ "$2" = "create" ]; then\n${behavior}\nfi\n` +
      `exit 0\n`,
    { mode: 0o755 }
  );
  return binDir;
}

test('scripts/install.sh --with-labels does not abort the whole install when a label already exists', () => {
  // Regression guard, found by code review: the label-creation loop used a
  // bare `err=$(...)` assignment followed by a separate `if [ $? -eq 0 ]`.
  // Under `set -e` (active at the top of this script), a failing command
  // substitution used as a plain assignment statement aborts the entire
  // script immediately — so the very first "already exists" (the normal
  // case on any re-run, since labels created on a prior run still exist)
  // would have killed the installer after creating only 1 of 15 labels,
  // with no "Installation complete" footer and no error message explaining
  // why. Empirically confirmed this exact bash behavior in isolation
  // (`bash -c 'set -e; x=$(false); echo unreached'` never prints) before
  // fixing it by guarding the assignment as an `if` condition instead.
  const binDir = mkFakeGh(
    `  echo "$3" >> "$GH_CALL_LOG"\n` +
      `  if [ "$3" = "intake" ]; then echo "already exists" >&2; exit 1; fi\n` +
      `  exit 0\n`
  );
  const logFile = path.join(binDir, 'calls.log');
  const dir = mkTmpRepo();
  fs.mkdirSync(path.join(dir, '.git'));
  const installShPath = path.join(__dirname, '..', 'scripts', 'install.sh');
  try {
    const output = execFileSync('bash', [installShPath, '--with-labels', dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GH_CALL_LOG: logFile },
    });
    assert.match(output, /Skipped \(exists\): intake/);
    assert.match(output, /=== Installation complete ===/, 'script must reach its normal end, not abort early');
    const attempted = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    const labelCount = loadLabels(packageRoot).length;
    assert.equal(
      attempted.length,
      labelCount,
      `expected all ${labelCount} labels attempted, got: ${JSON.stringify(attempted)}`
    );
  } finally {
    rm(dir);
    rm(binDir);
  }
});

test('scripts/install.sh --with-labels is immune to CRLF line endings in labels.tsv', () => {
  // Regression guard, found by code review: IFS=$'\t' only splits on tabs,
  // so a CRLF-checked-out labels.tsv (e.g. a Windows clone with
  // core.autocrlf=true and no .gitattributes pinning this repo to LF) would
  // leave a trailing \r on whichever field `read` captures last — corrupting
  // --color/--description — while labels.js's `.trim()` is immune, silently
  // reintroducing a JS-vs-bash divergence in the exact file meant to
  // eliminate that class of bug. Builds a throwaway copy of the real
  // .github tree with labels.tsv's line endings swapped to CRLF, so this
  // exercises the actual shipped script/data, not a hand-rolled fixture.
  const binDir = mkFakeGh(`  echo "$*" >> "$GH_CALL_LOG"\n  exit 0\n`);
  const logFile = path.join(binDir, 'calls.log');
  const repoRoot = path.join(__dirname, '..');
  const crlfRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'crlf-repo-'));
  const dir = mkTmpRepo();
  fs.mkdirSync(path.join(dir, '.git'));
  try {
    fs.cpSync(path.join(repoRoot, '.github'), path.join(crlfRepo, '.github'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'scripts'), path.join(crlfRepo, 'scripts'), { recursive: true });
    const lf = fs.readFileSync(path.join(crlfRepo, '.github', 'scripts', LABELS_TSV), 'utf8');
    fs.writeFileSync(path.join(crlfRepo, '.github', 'scripts', LABELS_TSV), lf.replace(/\n/g, '\r\n'));

    execFileSync('bash', [path.join(crlfRepo, 'scripts', 'install.sh'), '--with-labels', dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GH_CALL_LOG: logFile },
    });

    const calls = fs.readFileSync(logFile, 'utf8');
    assert.doesNotMatch(calls, /\r/, `a gh invocation carried a raw \\r: ${JSON.stringify(calls)}`);
    assert.match(calls, /--description Applied to a sprint's task-breakdown children/);
  } finally {
    rm(dir);
    rm(binDir);
    rm(crlfRepo);
  }
});

test('scripts/install.sh --with-labels does not drop the last label when labels.tsv has no trailing newline', () => {
  // Regression guard, found by code review: bash's `read` returns non-zero
  // on a file's final line if it isn't newline-terminated, even though it
  // still populated the read variables with that line's content — a bare
  // `while read ...; do ... done < file` loop condition treats that
  // non-zero return as "stop", silently never running the body for the
  // last label. labels.js is unaffected (splits the whole file content on
  // '\n', not a line-at-a-time reader).
  const binDir = mkFakeGh(`  echo "$*" >> "$GH_CALL_LOG"\n  exit 0\n`);
  const logFile = path.join(binDir, 'calls.log');
  const repoRoot = path.join(__dirname, '..');
  const noNlRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'no-nl-repo-'));
  const dir = mkTmpRepo();
  fs.mkdirSync(path.join(dir, '.git'));
  try {
    fs.cpSync(path.join(repoRoot, '.github'), path.join(noNlRepo, '.github'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'scripts'), path.join(noNlRepo, 'scripts'), { recursive: true });
    const tsvPath = path.join(noNlRepo, '.github', 'scripts', LABELS_TSV);
    const withNl = fs.readFileSync(tsvPath, 'utf8');
    assert.match(withNl, /\n$/, 'fixture assumption: the real labels.tsv ends with a newline');
    fs.writeFileSync(tsvPath, withNl.replace(/\n$/, '')); // strip the final newline only

    execFileSync('bash', [path.join(noNlRepo, 'scripts', 'install.sh'), '--with-labels', dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GH_CALL_LOG: logFile },
    });

    const attempted = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    const labelCount = loadLabels(repoRoot).length;
    assert.equal(
      attempted.length,
      labelCount,
      `expected all ${labelCount} labels attempted (including the last, unterminated line), got: ${JSON.stringify(attempted)}`
    );
  } finally {
    rm(dir);
    rm(binDir);
    rm(noNlRepo);
  }
});

test('scripts/install.sh --with-labels strips a stray leading space from a label name (matches labels.js\'s whole-line .trim())', () => {
  // Regression guard, found by code review: IFS=$'\t' read only splits on
  // tabs, so a stray leading space at the very start of a labels.tsv line
  // is captured as part of $name, while labels.js's `.trim()` on the whole
  // line strips it before splitting — a real JS-vs-bash divergence in the
  // exact file meant to eliminate that class of bug.
  const binDir = mkFakeGh(`  echo "[$3]" >> "$GH_CALL_LOG"\n  exit 0\n`);
  const logFile = path.join(binDir, 'calls.log');
  const repoRoot = path.join(__dirname, '..');
  const leadingSpaceRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'leading-space-repo-'));
  const dir = mkTmpRepo();
  fs.mkdirSync(path.join(dir, '.git'));
  try {
    fs.cpSync(path.join(repoRoot, '.github'), path.join(leadingSpaceRepo, '.github'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'scripts'), path.join(leadingSpaceRepo, 'scripts'), { recursive: true });
    const tsvPath = path.join(leadingSpaceRepo, '.github', 'scripts', LABELS_TSV);
    fs.writeFileSync(tsvPath, ' sprint-child\t1D76DB\tsome desc\n');

    execFileSync('bash', [path.join(leadingSpaceRepo, 'scripts', 'install.sh'), '--with-labels', dir], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GH_CALL_LOG: logFile },
    });

    const calls = fs.readFileSync(logFile, 'utf8');
    assert.match(calls, /^\[sprint-child\]$/m, `expected the leading space stripped from the label name, got: ${JSON.stringify(calls)}`);
  } finally {
    rm(dir);
    rm(binDir);
    rm(leadingSpaceRepo);
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

// Rolling QA migration note (1.9.0)

test('rollingQaMigrationNote shows for pre-1.9.0 installs (or no manifest) that had auto-qa-request', () => {
  const { rollingQaMigrationNote } = __test__;
  assert.match(rollingQaMigrationNote('1.8.0', true), /ONE rolling QA issue/);
  assert.match(rollingQaMigrationNote('1.8.0', true), /DELIVERY_OS_AUTO_QA_MODE=per-change/);
  assert.match(rollingQaMigrationNote(undefined, true), /left as they are/);
  assert.equal(rollingQaMigrationNote('1.9.0', true), null);
  assert.equal(rollingQaMigrationNote('1.10.2', true), null);
  assert.equal(rollingQaMigrationNote('1.8.0', false), null);
});

test('install --update prints the rolling QA note when upgrading a 1.8.0 install', () => {
  const dir = mkTmpRepo();
  const lines = [];
  const origLog = console.log;
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'auto-qa-request.yml'), '# 1.8.0 per-change workflow');
    fs.writeFileSync(path.join(dir, '.github', 'delivery-os.json'), JSON.stringify({ version: '1.8.0' }));
    console.log = (...args) => lines.push(args.join(' '));
    runInstall({ targetDir: dir, overwrite: true });
  } finally {
    console.log = origLog;
  }
  try {
    assert.match(lines.join('\n'), /ONE rolling QA issue/);
  } finally {
    rm(dir);
  }
});

test('isOlderVersion compares x.y.z numerically, not lexically', () => {
  const { isOlderVersion } = __test__;
  assert.equal(isOlderVersion('1.8.0', '1.9.0'), true);
  assert.equal(isOlderVersion('1.9.0', '1.9.0'), false);
  assert.equal(isOlderVersion('1.10.0', '1.9.0'), false, '1.10 is newer than 1.9');
  assert.equal(isOlderVersion('1.9', '1.9.1'), true, 'missing patch counts as 0');
  assert.equal(isOlderVersion('2.0.0', '1.99.99'), false);
  assert.equal(isOlderVersion('garbage', '0.0.1'), true, 'unparseable parts count as 0');
});

test('a second plain install is a no-op: edited workflows are kept and the manifest is not rewritten', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.' }));
    const wf = path.join(dir, '.github', 'workflows', `${WORKFLOWS[0]}.yml`);
    fs.writeFileSync(wf, '# locally edited');
    inRepoQuietly(dir, () => runInstall({ targetDir: '.' }));
    assert.equal(fs.readFileSync(wf, 'utf8'), '# locally edited');
  } finally {
    rm(dir);
  }
});

test('--overwrite replaces an edited Delivery OS workflow but leaves unrelated workflows alone', () => {
  const dir = mkTmpRepo();
  try {
    const wfDir = path.join(dir, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'my-own-ci.yml'), '# mine');
    fs.writeFileSync(path.join(wfDir, `${WORKFLOWS[0]}.yml`), '# stale');
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', overwrite: true }));
    assert.notEqual(fs.readFileSync(path.join(wfDir, `${WORKFLOWS[0]}.yml`), 'utf8'), '# stale');
    assert.equal(fs.readFileSync(path.join(wfDir, 'my-own-ci.yml'), 'utf8'), '# mine');
  } finally {
    rm(dir);
  }
});

test('uninstall leaves unrelated workflows in place', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.' }));
    const other = path.join(dir, '.github', 'workflows', 'my-own-ci.yml');
    fs.writeFileSync(other, '# mine');
    inRepoQuietly(dir, () => runUninstall({ targetDir: '.' }));
    assert.equal(fs.readFileSync(other, 'utf8'), '# mine');
    assert.equal(fs.existsSync(path.join(dir, '.github', 'workflows', `${WORKFLOWS[0]}.yml`)), false);
  } finally {
    rm(dir);
  }
});

test('install creates a target directory that does not exist yet', () => {
  const dir = mkTmpRepo();
  try {
    const nested = path.join(dir, 'a', 'b');
    inRepoQuietly(dir, () => runInstall({ targetDir: nested }));
    assert.ok(fs.existsSync(path.join(nested, '.github', 'workflows', `${WORKFLOWS[0]}.yml`)));
    assert.equal(readManifest(nested).version, pkgVersion);
  } finally {
    rm(dir);
  }
});

test('templates are only installed with --with-templates', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.' }));
    for (const t of TEMPLATES) {
      assert.equal(fs.existsSync(path.join(dir, '.github', 'ISSUE_TEMPLATE', t)), false, `${t} should not be installed`);
    }
  } finally {
    rm(dir);
  }
});

// ---- bundles (full / lite) ----

function statusOutput(dir) {
  const lines = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  console.log = (...args) => lines.push(args.join(' '));
  return (async () => {
    try {
      process.chdir(dir);
      await runStatus({ targetDir: '.', checkUpdates: false });
      return lines.join('\n');
    } finally {
      console.log = origLog;
      process.chdir(origCwd);
    }
  })();
}

test('the lite bundle is a strict subset of full, and full is everything', () => {
  assert.deepEqual(BUNDLES.full.workflows, WORKFLOWS);
  assert.deepEqual(BUNDLES.full.scripts, SCRIPTS);
  assert.deepEqual(BUNDLES.full.templates, TEMPLATES);
  for (const kind of ['workflows', 'scripts', 'templates']) {
    for (const item of BUNDLES.lite[kind]) assert.ok(BUNDLES.full[kind].includes(item), `lite ${kind} has ${item}, which full doesn't`);
    assert.ok(BUNDLES.lite[kind].length < BUNDLES.full[kind].length, `lite should drop some ${kind}`);
  }
});

test('lite ships every script its workflows require (apart from the QA ones it leaves out), and every template exists', () => {
  for (const wf of BUNDLES.lite.workflows) {
    const required = [].concat(REQUIRED_SCRIPT_BY_WORKFLOW[wf] || []);
    for (const script of required) assert.ok(BUNDLES.lite.scripts.includes(script), `${wf} requires ${script}.js, which lite doesn't ship`);
  }
  for (const t of BUNDLES.lite.templates) assert.ok(fs.existsSync(path.join(packageRoot, '.github', 'ISSUE_TEMPLATE', t)), `${t} is missing`);
});

test('the full release workflows are untouched by lite, and lite ships its own with no QA approver or roll-up', () => {
  const lite = (f) => fs.readFileSync(path.join(packageRoot, '.github', 'lite', 'workflows', f), 'utf8');
  assert.doesNotMatch(lite('authorize-deployment.yml'), /QA_APPROVER|qa-approver/);
  assert.doesNotMatch(lite('notify-release-approver.yml'), /release-rollup|qa-request/);
  assert.match(lite('authorize-deployment.yml'), /authorize-deployment-verdict\.js/);
  const full = fs.readFileSync(path.join(packageRoot, '.github', 'workflows', 'authorize-deployment.yml'), 'utf8');
  assert.match(full, /QA_APPROVER/);
});

test('install --bundle lite puts the lite release workflows, release template and label list in place', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite', withTemplates: true }));
    const read = (...p) => fs.readFileSync(path.join(dir, '.github', ...p), 'utf8');
    assert.doesNotMatch(read('workflows', 'authorize-deployment.yml'), /QA_APPROVER/);
    assert.doesNotMatch(read('workflows', 'notify-release-approver.yml'), /release-rollup/);
    assert.doesNotMatch(read('ISSUE_TEMPLATE', 'production_release_qa_signoff.yml'), /QA Recommendation/);
    const labels = read('scripts', LABELS_TSV);
    assert.doesNotMatch(labels, /^qa-request\t/m);
    assert.doesNotMatch(labels, /^qa-rollup\t/m);
    assert.match(labels, /^production\t/m);
    assert.match(labels, /^ready-for-deploy\t/m);
  } finally {
    rm(dir);
  }
});

test('a default install copies the full release workflows and labels byte for byte', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    for (const [rel, src] of [
      ['workflows/authorize-deployment.yml', '.github/workflows/authorize-deployment.yml'],
      ['workflows/notify-release-approver.yml', '.github/workflows/notify-release-approver.yml'],
      ['scripts/labels.tsv', '.github/scripts/labels.tsv'],
      ['ISSUE_TEMPLATE/production_release_qa_signoff.yml', '.github/ISSUE_TEMPLATE/production_release_qa_signoff.yml'],
    ]) {
      assert.equal(fs.readFileSync(path.join(dir, '.github', rel), 'utf8'), fs.readFileSync(path.join(packageRoot, src), 'utf8'), rel);
    }
  } finally {
    rm(dir);
  }
});

test('install --bundle lite installs only the lite set and records the bundle', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite', withTemplates: true }));
    const have = (sub) => fs.readdirSync(path.join(dir, '.github', sub)).sort();
    assert.deepEqual(have('workflows'), BUNDLES.lite.workflows.map((w) => `${w}.yml`).sort());
    assert.deepEqual(have('ISSUE_TEMPLATE'), [...BUNDLES.lite.templates].sort());
    for (const s of BUNDLES.lite.scripts) assert.ok(fs.existsSync(path.join(dir, '.github', 'scripts', `${s}.js`)));
    assert.equal(fs.existsSync(path.join(dir, '.github', 'scripts', 'auto-qa-request.js')), false);
    assert.equal(readManifest(dir).bundle, 'lite');
    assert.equal(readManifest(dir).version, pkgVersion);
  } finally {
    rm(dir);
  }
});

test('a default install is unchanged: every workflow, and no bundle field in the manifest', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.' }));
    for (const wf of WORKFLOWS) assert.ok(fs.existsSync(path.join(dir, '.github', 'workflows', `${wf}.yml`)), wf);
    assert.equal('bundle' in readManifest(dir), false);
    assert.equal(manifestBundle(readManifest(dir)), 'full');
    assert.equal(manifestBundle(null), 'full');
    assert.equal(manifestBundle({ bundle: 'bogus' }), 'full');
  } finally {
    rm(dir);
  }
});

test('status on a lite install reports 5/5 and flags nothing as missing or broken', async () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite', withTemplates: true }));
    const output = await statusOutput(dir);
    assert.match(output, /Summary: 5\/5 workflows, 5\/5 templates/);
    assert.match(output, /Bundle: lite/);
    assert.doesNotMatch(output, /Missing workflows/);
    assert.doesNotMatch(output, /Broken install detected/);
  } finally {
    rm(dir);
  }
});

test('status still flags a lite install whose own script is missing', async () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite' }));
    fs.unlinkSync(path.join(dir, '.github', 'scripts', 'sprint-child-creator.js'));
    const output = await statusOutput(dir);
    assert.match(output, /Broken install detected/);
    assert.match(output, /sprint-child-creator\.js/);
  } finally {
    rm(dir);
  }
});

test('the update command a lite install is pointed at keeps it lite; a full one is unchanged', () => {
  assert.match(buildUpdateCommand({ hasTemplates: true, hasSkill: false, bundle: 'lite' }), /--bundle lite/);
  assert.doesNotMatch(buildUpdateCommand({ hasTemplates: true, hasSkill: false }), /--bundle/);
});

test('a plain --update on a lite install stays lite', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite' }));
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', overwrite: true }));
    assert.equal(fs.existsSync(path.join(dir, '.github', 'workflows', 'auto-qa-request.yml')), false);
    assert.equal(readManifest(dir).bundle, 'lite');
  } finally {
    rm(dir);
  }
});

test('--bundle full on a lite install fills it out and drops the bundle field', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite' }));
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'full' }));
    for (const wf of WORKFLOWS) assert.ok(fs.existsSync(path.join(dir, '.github', 'workflows', `${wf}.yml`)), wf);
    assert.equal(manifestBundle(readManifest(dir)), 'full');
    assert.equal(readManifest(dir).version, pkgVersion, 'the recorded version is kept');
  } finally {
    rm(dir);
  }
});

test('an unknown bundle installs nothing and sets a failing exit code', () => {
  const dir = mkTmpRepo();
  const origErr = console.error;
  const origExit = process.exitCode;
  try {
    console.error = () => {};
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'bogus' }));
    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(dir, '.github')), false);
  } finally {
    process.exitCode = origExit;
    console.error = origErr;
    rm(dir);
  }
});

// ---- --set-approvers (a stubbed `gh` on PATH; nothing touches GitHub) ----

// Runs fn with a fake `gh` first on PATH. FAKE_GH_VARS = variables that
// already exist, FAKE_GH_LOGIN = who `gh api user` says you are,
// FAKE_GH_UNAUTH=1 = `gh auth status` fails. Every call is appended to the log.
function withFakeGh({ vars = '', unauth = false, login = 'solo-dev' } = {}, fn) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-os-gh-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'echo "$@" >> "$FAKE_GH_LOG"',
      'case "$1 $2" in',
      '  "auth status") [ -n "$FAKE_GH_UNAUTH" ] && exit 1 ;;',
      '  "variable list") printf "%s\\n" $FAKE_GH_VARS ;;',
      '  "api user") echo "$FAKE_GH_LOGIN" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 }
  );
  const saved = { PATH: process.env.PATH };
  Object.assign(process.env, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_LOG: log,
    FAKE_GH_VARS: vars,
    FAKE_GH_LOGIN: login,
  });
  if (unauth) process.env.FAKE_GH_UNAUTH = '1';
  try {
    return fn(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));
  } finally {
    process.env.PATH = saved.PATH;
    for (const k of ['FAKE_GH_LOG', 'FAKE_GH_VARS', 'FAKE_GH_LOGIN', 'FAKE_GH_UNAUTH']) delete process.env[k];
    rm(bin);
  }
}

function gitRepo() {
  const dir = mkTmpRepo();
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

test('a lite install sets RELEASE_APPROVER to the person installing, and says so', () => {
  const dir = gitRepo();
  try {
    withFakeGh({}, (calls) => {
      const lines = [];
      const origLog = console.log;
      console.log = (...a) => lines.push(a.join(' '));
      try {
        const cwd = process.cwd();
        process.chdir(dir);
        runInstall({ targetDir: '.', bundle: 'lite' });
        process.chdir(cwd);
      } finally {
        console.log = origLog;
      }
      assert.match(calls(), /variable set RELEASE_APPROVER --body solo-dev/);
      assert.doesNotMatch(calls(), /QA_APPROVER/);
      assert.match(lines.join('\n'), /Set RELEASE_APPROVER to @solo-dev/);
      assert.match(lines.join('\n'), /RELEASE_APPROVER: done/);
    });
  } finally {
    rm(dir);
  }
});

test('--set-approvers never overwrites an approver that is already set', () => {
  const dir = gitRepo();
  try {
    withFakeGh({ vars: 'RELEASE_APPROVER QA_APPROVER' }, (calls) => {
      inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite' }));
      assert.doesNotMatch(calls(), /variable set/);
    });
  } finally {
    rm(dir);
  }
});

test('--set-approvers skips cleanly when gh is not signed in, and the install still completes', () => {
  const dir = gitRepo();
  try {
    withFakeGh({ unauth: true }, (calls) => {
      inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite' }));
      assert.doesNotMatch(calls(), /variable set/);
      assert.equal(readManifest(dir).bundle, 'lite');
    });
  } finally {
    rm(dir);
  }
});

test('--dry-run and --no-set-approvers set nothing; a full install does not set approvers by default', () => {
  const dir = gitRepo();
  try {
    withFakeGh({}, (calls) => {
      inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite', dryRun: true }));
      inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'lite', setApprovers: false }));
      inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'full' }));
      assert.doesNotMatch(calls(), /variable set/);
      assert.doesNotMatch(calls(), /variable list/);
    });
  } finally {
    rm(dir);
  }
});

test('--set-approvers can be asked for on a full install', () => {
  const dir = gitRepo();
  try {
    withFakeGh({}, (calls) => {
      inRepoQuietly(dir, () => runInstall({ targetDir: '.', setApprovers: true }));
      assert.match(calls(), /variable set RELEASE_APPROVER --body solo-dev/);
    });
  } finally {
    rm(dir);
  }
});

// ---- --only / --skip / list ----

const wfFiles = (dir) => fs.readdirSync(path.join(dir, '.github', 'workflows')).sort();

test('every workflow has a description, and what it needs is a real workflow', () => {
  for (const wf of WORKFLOWS) {
    assert.ok(WORKFLOW_INFO[wf] && WORKFLOW_INFO[wf].summary, `${wf} has no description`);
    for (const need of WORKFLOW_INFO[wf].needs) assert.ok(WORKFLOWS.includes(need), `${wf} needs unknown ${need}`);
  }
  assert.deepEqual(Object.keys(WORKFLOW_INFO).sort(), [...WORKFLOWS].sort());
});

test('parseNameList trims, drops .yml, de-duplicates, and leaves an absent flag alone', () => {
  assert.deepEqual(parseNameList('a, b.yml ,a,,'), ['a', 'b']);
  assert.deepEqual(parseNameList(['a,b', 'c']), ['a', 'b', 'c']);
  assert.equal(parseNameList(undefined), null);
});

test('resolveSelection: only, skip, errors, and keeping a prior selection', () => {
  const only = resolveSelection({ bundle: 'full', only: ['auto-close-sprint', 'sprint-child-creator'] });
  assert.deepEqual(only.workflows, ['sprint-child-creator', 'auto-close-sprint'], 'keeps the bundle order');
  assert.equal(only.custom, true);

  const skip = resolveSelection({ bundle: 'full', skip: ['telegram-issues'] });
  assert.equal(skip.workflows.length, WORKFLOWS.length - 1);
  assert.ok(!skip.workflows.includes('telegram-issues'));

  const none = resolveSelection({ bundle: 'full' });
  assert.deepEqual(none.workflows, WORKFLOWS);
  assert.equal(none.custom, false);
  assert.deepEqual(none.scripts, SCRIPTS, 'an unnarrowed install ships exactly the bundle\'s scripts');

  assert.match(resolveSelection({ bundle: 'full', only: ['nope'] }).error, /Unknown workflow.*nope/);
  assert.match(resolveSelection({ bundle: 'lite', only: ['auto-qa-request'] }).error, /for the lite bundle/);
  assert.match(resolveSelection({ bundle: 'full', only: ['a'], skip: ['b'] }).error, /not both/);
  assert.match(resolveSelection({ bundle: 'lite', skip: BUNDLES.lite.workflows }).error, /nothing to install/);
  assert.deepEqual(resolveSelection({ bundle: 'full', keepPrior: ['setup-labels'] }).workflows, ['setup-labels']);
});

test('resolveSelection warns when a workflow is chosen without what it works with', () => {
  assert.match(resolveSelection({ bundle: 'full', only: ['qa-rollup-approval'] }).warnings.join(), /auto-qa-request/);
  assert.match(resolveSelection({ bundle: 'full', only: ['auto-close-sprint'] }).warnings.join(), /sprint-child-creator/);
  assert.deepEqual(resolveSelection({ bundle: 'full', only: ['telegram-issues'] }).warnings, []);
});

test('scriptsForWorkflows ships only what the chosen workflows require', () => {
  assert.deepEqual(scriptsForWorkflows('full', ['sprint-child-creator', 'setup-labels']).sort(), ['labels', 'sprint-child-creator']);
  assert.deepEqual(scriptsForWorkflows('full', ['telegram-issues']), []);
  const notify = scriptsForWorkflows('full', ['notify-release-approver']);
  assert.ok(notify.includes('release-rollup') && notify.includes('auto-qa-request'), 'the full notify workflow runs the roll-up');
  assert.deepEqual(scriptsForWorkflows('lite', ['notify-release-approver']), [], 'lite\'s notify needs no script');
  for (const wf of WORKFLOWS) {
    for (const script of [].concat(REQUIRED_SCRIPT_BY_WORKFLOW[wf] || [])) {
      assert.ok(scriptsForWorkflows('full', [wf]).includes(script), `${wf} -> ${script}`);
    }
  }
});

test('install --only installs just those workflows and their scripts, records them, and status is happy', async () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', only: 'sprint-child-creator,auto-close-sprint,setup-labels' }));
    assert.deepEqual(wfFiles(dir), ['auto-close-sprint.yml', 'setup-labels.yml', 'sprint-child-creator.yml']);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.github', 'scripts')).sort(), ['auto-close-sprint.js', 'labels.js', 'labels.tsv', 'package.json', 'sprint-child-creator.js']);
    assert.deepEqual(readManifest(dir).workflows, ['sprint-child-creator', 'auto-close-sprint', 'setup-labels']);
    const output = await statusOutput(dir);
    assert.match(output, /Summary: 3\/3 workflows/);
    assert.match(output, /selected workflows only/);
    assert.doesNotMatch(output, /Missing workflows|Broken install/);
  } finally {
    rm(dir);
  }
});

test('install --skip leaves out just those, on full and on lite', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', skip: 'telegram-issues,auto-assign-qa' }));
    assert.deepEqual(wfFiles(dir), WORKFLOWS.filter((w) => !['telegram-issues', 'auto-assign-qa'].includes(w)).map((w) => `${w}.yml`).sort());
  } finally {
    rm(dir);
  }
  const lite = mkTmpRepo();
  try {
    inRepoQuietly(lite, () => runInstall({ targetDir: '.', bundle: 'lite', skip: 'notify-release-approver' }));
    assert.deepEqual(wfFiles(lite), ['authorize-deployment.yml', 'auto-close-sprint.yml', 'setup-labels.yml', 'sprint-child-creator.yml']);
    assert.doesNotMatch(fs.readFileSync(path.join(lite, '.github', 'workflows', 'authorize-deployment.yml'), 'utf8'), /QA_APPROVER/, 'still lite\'s own version');
    assert.equal(readManifest(lite).bundle, 'lite');
  } finally {
    rm(lite);
  }
});

test('a plain --update keeps a narrowed install; --bundle resets it; --only changes it', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', only: 'sprint-child-creator,setup-labels' }));
    inRepoQuietly(dir, () => runInstall({ targetDir: '.', overwrite: true }));
    assert.deepEqual(wfFiles(dir), ['setup-labels.yml', 'sprint-child-creator.yml']);

    inRepoQuietly(dir, () => runInstall({ targetDir: '.', only: 'authorize-deployment' }));
    assert.deepEqual(readManifest(dir).workflows, ['authorize-deployment']);
    assert.ok(fs.existsSync(path.join(dir, '.github', 'workflows', 'authorize-deployment.yml')));

    inRepoQuietly(dir, () => runInstall({ targetDir: '.', bundle: 'full' }));
    assert.deepEqual(wfFiles(dir), WORKFLOWS.map((w) => `${w}.yml`).sort());
    assert.equal('workflows' in readManifest(dir), false, 'back to following the bundle');
  } finally {
    rm(dir);
  }
});

test('bad --only/--skip installs nothing and fails', () => {
  const origErr = console.error;
  const origExit = process.exitCode;
  const cases = [{ only: 'nope' }, { only: 'setup-labels', skip: 'auto-qa-request' }, { bundle: 'lite', only: 'telegram-issues' }];
  try {
    console.error = () => {};
    for (const opts of cases) {
      const dir = mkTmpRepo();
      try {
        process.exitCode = 0;
        inRepoQuietly(dir, () => runInstall({ targetDir: '.', ...opts }));
        assert.equal(process.exitCode, 1, JSON.stringify(opts));
        assert.equal(fs.existsSync(path.join(dir, '.github')), false, JSON.stringify(opts));
      } finally {
        rm(dir);
      }
    }
  } finally {
    process.exitCode = origExit;
    console.error = origErr;
  }
});

test('a default install records no workflows field, and manifestWorkflows ignores junk', () => {
  const dir = mkTmpRepo();
  try {
    inRepoQuietly(dir, () => runInstall({ targetDir: '.' }));
    assert.equal('workflows' in readManifest(dir), false);
  } finally {
    rm(dir);
  }
  assert.equal(manifestWorkflows(null, 'full'), null);
  assert.equal(manifestWorkflows({ workflows: 'x' }, 'full'), null);
  assert.equal(manifestWorkflows({ workflows: [] }, 'full'), null);
  assert.equal(manifestWorkflows({ workflows: ['bogus'] }, 'full'), null);
  assert.equal(manifestWorkflows({ workflows: WORKFLOWS }, 'full'), null, 'the whole bundle is not a narrowing');
  assert.deepEqual(manifestWorkflows({ workflows: ['setup-labels', 'bogus'] }, 'full'), ['setup-labels']);
});

test('list --json describes every workflow and both bundles', () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    runList({ json: true });
  } finally {
    console.log = origLog;
  }
  const out = JSON.parse(lines.join('\n'));
  assert.deepEqual(Object.keys(out.bundles).sort(), ['full', 'lite']);
  assert.equal(out.workflows.length, WORKFLOWS.length);
  const qa = out.workflows.find((w) => w.name === 'auto-qa-request');
  assert.deepEqual(qa.bundles, ['full']);
  assert.ok(out.workflows.find((w) => w.name === 'setup-labels').bundles.includes('lite'));
});

function installOutput(dir, opts) {
  const lines = [];
  const origLog = console.log;
  const cwd = process.cwd();
  console.log = (...a) => lines.push(a.join(' '));
  try {
    process.chdir(dir);
    runInstall({ targetDir: '.', ...opts });
  } finally {
    process.chdir(cwd);
    console.log = origLog;
  }
  return lines.join('\n');
}

test('lite next steps: a dry run says the approver will be set, not that you must set it', () => {
  const dir = gitRepo();
  try {
    const out = installOutput(dir, { bundle: 'lite', dryRun: true });
    assert.match(out, /RELEASE_APPROVER: will be set to your GitHub login/);
    assert.doesNotMatch(out, /or re-run with --set-approvers/);
    assert.match(out, /1\. Create labels/, 'labels were not created in a dry run');
  } finally {
    rm(dir);
  }
});

test('lite next steps: once labels are created, the "create labels" step is gone and the rest renumber', () => {
  const dir = gitRepo();
  try {
    withFakeGh({}, () => {
      const out = installOutput(dir, { bundle: 'lite', withLabels: true, withTemplates: true, withSkill: true });
      assert.match(out, /Created \d+ label/);
      assert.doesNotMatch(out, /Create labels: Actions/);
      assert.match(out, /1\. Configure the repo variable/);
      assert.match(out, /RELEASE_APPROVER: done/);
    });
  } finally {
    rm(dir);
  }
});

test('lite next steps: with no labels created it still points at Setup Labels, then the variable', () => {
  const dir = mkTmpRepo();
  try {
    const out = installOutput(dir, { bundle: 'lite', withTemplates: true, withSkill: true });
    assert.match(out, /1\. Create labels: Actions/);
    assert.match(out, /2\. Configure the repo variable/);
  } finally {
    rm(dir);
  }
});

test('full next steps are unchanged: labels, QA variables, Telegram secrets', () => {
  const dir = mkTmpRepo();
  try {
    const out = installOutput(dir, { withTemplates: true, withSkill: true });
    const steps = out.slice(out.indexOf('Next steps:'), out.indexOf('See https://'));
    assert.equal(
      steps.trim(),
      [
        'Next steps:',
        '  1. Create labels: Actions → Setup Labels → Run workflow',
        '  2. Configure repo variables (Settings → Secrets and variables → Actions):',
        '     - RELEASE_APPROVER: GitHub username of release approver',
        '     - QA_APPROVER: GitHub username of QA approver',
        '     - QA_ASSIGNEES: Comma-separated usernames for QA assignment',
        '  3. Add secrets (optional, for Telegram): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID',
      ].join('\n')
    );
  } finally {
    rm(dir);
  }
});
