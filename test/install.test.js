'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./harness');
const { runInstall, runStatus, runUninstall, __test__ } = require('../src/install');
const { manifestPath, readManifest, writeManifest, skillPath, SKILL_REL_PATH, WORKFLOWS, TEMPLATES } =
  __test__;

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
    for (const wf of WORKFLOWS) {
      assert.ok(fs.existsSync(path.join(workflowsDest, `${wf}.yml`)), `missing ${wf}.yml`);
    }
    for (const t of TEMPLATES) {
      assert.ok(fs.existsSync(path.join(templatesDest, t)), `missing template ${t}`);
    }
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
