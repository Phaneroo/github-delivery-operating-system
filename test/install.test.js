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
  LABELS_TSV,
  setupLabelsMissingFiles,
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
