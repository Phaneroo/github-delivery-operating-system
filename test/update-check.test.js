'use strict';

// #90: the "your Delivery OS install is out of date" prompts — the Claude
// Code SessionStart hook installed with --with-skill, and the terminal
// snippet from `delivery-os shell-hook`.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { test } = require('./harness');
const { runInstall, runUninstall, __test__: installTest } = require('../src/install');
const hook = require('../.claude/hooks/delivery-os-update-check');
const { __test__: shellTest } = require('../src/shell-hook');

const {
  updateHookPath,
  SETTINGS_REL_PATH,
  UPDATE_HOOK_ENTRY,
  registerUpdateHook,
  hasUpdateHookRegistered,
  manifestPath,
  TEMPLATES,
  skillPath,
} = installTest;

const HOOK_SCRIPT = path.join(__dirname, '..', '.claude', 'hooks', 'delivery-os-update-check.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-os-update-check-'));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function quietly(dir, fn) {
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

function readSettingsFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_REL_PATH), 'utf8'));
}

function writeManifestVersion(dir, version) {
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  fs.writeFileSync(manifestPath(dir), JSON.stringify({ version }));
}

function seedCache(cacheHome, version, ageMs = 0) {
  const file = hook.cacheFile({ XDG_CACHE_HOME: cacheHome });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${version}\n`);
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

// --- The Claude Code hook script ---

test('update hook: TEMPLATES matches src/install.js (it is duplicated because the hook runs standalone)', () => {
  assert.deepEqual(hook.TEMPLATES, TEMPLATES);
});

test('update hook: says nothing when the install is current or ahead, or a version is unknown', () => {
  assert.equal(hook.buildOutput('1.9.0', '1.9.0', 'cmd'), null);
  assert.equal(hook.buildOutput('2.0.0', '1.9.0', 'cmd'), null);
  assert.equal(hook.buildOutput(null, '1.9.0', 'cmd'), null);
  assert.equal(hook.buildOutput('1.8.0', null, 'cmd'), null);
});

test('update hook: when behind, tells the user and asks Claude to offer (not run) the update', () => {
  const out = hook.buildOutput('1.8.0', '1.9.0', 'npx github-delivery-os@latest install --update .');
  assert.match(out.systemMessage, /Delivery OS 1\.8\.0 installed, 1\.9\.0 available/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /install --update \./);
  assert.match(out.hookSpecificOutput.additionalContext, /Only run it after the user explicitly confirms/);
});

test('update hook: a fresh cache is used without a network call', async () => {
  const dir = mkTmp();
  try {
    const file = seedCache(dir, '1.9.0');
    let fetched = false;
    const v = await hook.latestVersion({ file, fetch: async () => { fetched = true; return '9.9.9'; } });
    assert.equal(v, '1.9.0');
    assert.equal(fetched, false);
  } finally {
    rm(dir);
  }
});

test('update hook: a stale cache is refreshed from npm and rewritten', async () => {
  const dir = mkTmp();
  try {
    const file = seedCache(dir, '1.8.0', hook.CACHE_TTL_MS + 60000);
    const v = await hook.latestVersion({ file, fetch: async () => '1.9.0' });
    assert.equal(v, '1.9.0');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), '1.9.0');
  } finally {
    rm(dir);
  }
});

test('update hook: offline falls back to a stale cache, or to nothing', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'github-delivery-os', 'latest-version');
    assert.equal(await hook.latestVersion({ file, fetch: async () => null }), null);
    seedCache(dir, '1.8.0', hook.CACHE_TTL_MS + 60000);
    assert.equal(await hook.latestVersion({ file, fetch: async () => null }), '1.8.0');
  } finally {
    rm(dir);
  }
});

test('update hook: a garbage cache file is ignored', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'latest-version');
    fs.writeFileSync(file, '<html>');
    assert.equal(hook.readCache(file), null);
  } finally {
    rm(dir);
  }
});

test('update hook: suggested command carries --with-templates/--with-skill only when installed', () => {
  const dir = mkTmp();
  try {
    assert.equal(hook.updateCommand(dir), 'npx github-delivery-os@latest install --with-labels --update .');
    fs.mkdirSync(path.join(dir, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'ISSUE_TEMPLATE', 'task.yml'), '');
    fs.mkdirSync(path.dirname(skillPath(dir)), { recursive: true });
    fs.writeFileSync(skillPath(dir), '');
    assert.equal(
      hook.updateCommand(dir),
      'npx github-delivery-os@latest install --with-templates --with-skill --with-labels --update .'
    );
  } finally {
    rm(dir);
  }
});

// Runs the real script as Claude Code would, with a fresh seeded cache so no
// network call happens.
function runHookScript(repoDir, cacheHome) {
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: repoDir, XDG_CACHE_HOME: cacheHome },
    encoding: 'utf8',
  });
}

test('update hook script: prints JSON when behind, nothing when current or not installed, always exits 0', () => {
  const repo = mkTmp();
  const cache = mkTmp();
  try {
    seedCache(cache, '1.9.0');

    let r = runHookScript(repo, cache); // no manifest
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');

    writeManifestVersion(repo, '1.9.0');
    r = runHookScript(repo, cache);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');

    writeManifestVersion(repo, '1.8.0');
    r = runHookScript(repo, cache);
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /1\.8\.0 installed, 1\.9\.0 available/);

    fs.writeFileSync(manifestPath(repo), '{ not json');
    r = runHookScript(repo, cache);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    rm(repo);
    rm(cache);
  }
});

// --- Installing it with --with-skill ---

test('--with-skill installs the hook script and registers it in .claude/settings.json', () => {
  const dir = mkTmp();
  try {
    quietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    assert.ok(fs.existsSync(updateHookPath(dir)));
    assert.deepEqual(readSettingsFile(dir).hooks.SessionStart, [UPDATE_HOOK_ENTRY]);
    assert.ok(hasUpdateHookRegistered(dir));
    assert.equal(JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')).version, require('../package.json').version);
  } finally {
    rm(dir);
  }
});

test('install without --with-skill adds neither the hook nor settings.json', () => {
  const dir = mkTmp();
  try {
    quietly(dir, () => runInstall({ targetDir: '.', withTemplates: true }));
    assert.equal(fs.existsSync(updateHookPath(dir)), false);
    assert.equal(fs.existsSync(path.join(dir, SETTINGS_REL_PATH)), false);
  } finally {
    rm(dir);
  }
});

test('registering keeps existing settings and hooks, and never duplicates its own entry', () => {
  const dir = mkTmp();
  try {
    const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] };
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, SETTINGS_REL_PATH),
      JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [other], Stop: [] } })
    );
    quietly(dir, () => runInstall({ targetDir: '.', withSkill: true }));
    quietly(dir, () => runInstall({ targetDir: '.', withSkill: true, overwrite: true }));
    const settings = readSettingsFile(dir);
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
    assert.deepEqual(settings.hooks.Stop, []);
    assert.deepEqual(settings.hooks.SessionStart, [other, UPDATE_HOOK_ENTRY]);
  } finally {
    rm(dir);
  }
});

test('--update refreshes an outdated entry of ours in place; skip mode leaves it', () => {
  const dir = mkTmp();
  try {
    const old = { hooks: [{ type: 'command', command: 'node .claude/hooks/delivery-os-update-check.js' }] };
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS_REL_PATH), JSON.stringify({ hooks: { SessionStart: [old] } }));
    assert.equal(registerUpdateHook(dir, { overwrite: false, dryRun: false }), 'exists');
    assert.deepEqual(readSettingsFile(dir).hooks.SessionStart, [old]);
    assert.equal(registerUpdateHook(dir, { overwrite: true, dryRun: false }), 'updated');
    assert.deepEqual(readSettingsFile(dir).hooks.SessionStart, [UPDATE_HOOK_ENTRY]);
  } finally {
    rm(dir);
  }
});

test('an unparseable settings.json is left untouched', () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS_REL_PATH), '{ // a comment\n}');
    quietly(dir, () => runInstall({ targetDir: '.', withSkill: true }));
    assert.equal(fs.readFileSync(path.join(dir, SETTINGS_REL_PATH), 'utf8'), '{ // a comment\n}');
    assert.ok(fs.existsSync(updateHookPath(dir)), 'the script itself is still installed');
  } finally {
    rm(dir);
  }
});

test('dry-run --with-skill writes neither the hook nor settings.json', () => {
  const dir = mkTmp();
  try {
    quietly(dir, () => runInstall({ targetDir: '.', withSkill: true, dryRun: true }));
    assert.equal(fs.existsSync(updateHookPath(dir)), false);
    assert.equal(fs.existsSync(path.join(dir, SETTINGS_REL_PATH)), false);
  } finally {
    rm(dir);
  }
});

test('an existing hook script left stale in skip mode blocks the recorded version, like the skill', () => {
  const dir = mkTmp();
  try {
    quietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    writeManifestVersion(dir, '0.0.1');
    fs.writeFileSync(updateHookPath(dir), '// local edits');
    quietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    assert.equal(JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')).version, '0.0.1');
  } finally {
    rm(dir);
  }
});

test('uninstall --with-skill removes the hook script and only our settings entry', () => {
  const dir = mkTmp();
  try {
    const other = { hooks: [{ type: 'command', command: 'echo hi' }] };
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS_REL_PATH), JSON.stringify({ model: 'x', hooks: { SessionStart: [other] } }));
    quietly(dir, () => runInstall({ targetDir: '.', withSkill: true }));
    quietly(dir, () => runUninstall({ targetDir: '.', withSkill: true }));
    assert.equal(fs.existsSync(updateHookPath(dir)), false);
    assert.deepEqual(readSettingsFile(dir), { model: 'x', hooks: { SessionStart: [other] } });
  } finally {
    rm(dir);
  }
});

test('uninstall --with-skill deletes a settings.json that held nothing but our hook', () => {
  const dir = mkTmp();
  try {
    quietly(dir, () => runInstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    quietly(dir, () => runUninstall({ targetDir: '.', withTemplates: true, withSkill: true }));
    assert.equal(fs.existsSync(path.join(dir, SETTINGS_REL_PATH)), false);
    assert.equal(fs.existsSync(manifestPath(dir)), false);
  } finally {
    rm(dir);
  }
});

// --- The terminal snippet ---

test('shell snippet: install adds one marked block, re-install replaces it, uninstall removes only it', () => {
  const dir = mkTmp();
  try {
    const rc = path.join(dir, '.zshrc');
    fs.writeFileSync(rc, 'export FOO=1\n');
    assert.equal(shellTest.installSnippet(rc, 'zsh'), 'added');
    assert.equal(shellTest.installSnippet(rc, 'zsh'), 'updated');
    const content = fs.readFileSync(rc, 'utf8');
    assert.equal(content.split(shellTest.BEGIN_MARKER).length, 2, 'exactly one block');
    assert.ok(content.startsWith('export FOO=1\n'));
    assert.equal(shellTest.uninstallSnippet(rc), true);
    assert.equal(fs.readFileSync(rc, 'utf8'), 'export FOO=1\n');
    assert.equal(shellTest.uninstallSnippet(rc), false);
  } finally {
    rm(dir);
  }
});

test('shell snippet: a block missing its end marker is left alone', () => {
  const text = `a\n${shellTest.BEGIN_MARKER}\nb\n`;
  assert.deepEqual(shellTest.stripSnippet(text), { content: text, found: false });
});

test('shell snippet: detects zsh/bash from $SHELL, nothing else', () => {
  assert.equal(shellTest.detectShell({ SHELL: '/bin/zsh' }), 'zsh');
  assert.equal(shellTest.detectShell({ SHELL: '/usr/local/bin/bash' }), 'bash');
  assert.equal(shellTest.detectShell({ SHELL: '/usr/bin/fish' }), null);
  assert.equal(shellTest.detectShell({}), null);
});

function hasCommand(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
}

// Sources the real snippet in the given shell and runs the check from `cwd`.
// The seeded cache is fresh, so no background curl is started.
function runSnippet(shell, cwd, cacheHome) {
  const script = `${shellTest.buildSnippet(shell)}\ncd "${cwd}" && __delivery_os_check`;
  return spawnSync(shell, ['-c', script], {
    env: { ...process.env, XDG_CACHE_HOME: cacheHome, HOME: cacheHome },
    encoding: 'utf8',
  });
}

for (const shell of ['bash', 'zsh']) {
  test(`shell snippet (${shell}): reminds when behind, silent when current, outside git, or not installed`, () => {
    if (!hasCommand(shell) || !hasCommand('git')) return; // zsh isn't on every CI runner
    const repo = mkTmp();
    const cache = mkTmp();
    try {
      execFileSync('git', ['init', '-q', repo]);
      seedCache(cache, '1.9.0');

      let r = runSnippet(shell, repo, cache); // no manifest
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');

      writeManifestVersion(repo, '1.9.0');
      assert.equal(runSnippet(shell, repo, cache).stdout, '');

      writeManifestVersion(repo, '1.8.0');
      fs.mkdirSync(path.join(repo, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.github', 'ISSUE_TEMPLATE', 'task.yml'), '');
      r = runSnippet(shell, repo, cache);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Delivery OS 1\.8\.0 installed, 1\.9\.0 available/);
      assert.match(r.stdout, /npx github-delivery-os@latest install --with-templates --with-labels --update \./);

      fs.mkdirSync(path.join(repo, 'sub'));
      assert.match(runSnippet(shell, path.join(repo, 'sub'), cache).stdout, /1\.8\.0 installed/, 'works from a subdirectory');

      const notRepo = mkTmp();
      try {
        assert.equal(runSnippet(shell, notRepo, cache).stdout, '');
      } finally {
        rm(notRepo);
      }
    } finally {
      rm(repo);
      rm(cache);
    }
  });
}
