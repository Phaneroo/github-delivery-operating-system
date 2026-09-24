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
      assert.equal(r.stderr, '');

      writeManifestVersion(repo, '1.9.0');
      assert.equal(runSnippet(shell, repo, cache).stderr, '');

      writeManifestVersion(repo, '1.8.0');
      fs.mkdirSync(path.join(repo, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.github', 'ISSUE_TEMPLATE', 'task.yml'), '');
      r = runSnippet(shell, repo, cache);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', 'the reminder goes to stderr, never into captured output');
      assert.match(r.stderr, /Delivery OS 1\.8\.0 installed, 1\.9\.0 available/);
      assert.match(r.stderr, /npx github-delivery-os@latest install --with-templates --with-labels --update \./);

      fs.mkdirSync(path.join(repo, 'sub'));
      assert.match(runSnippet(shell, path.join(repo, 'sub'), cache).stderr, /1\.8\.0 installed/, 'works from a subdirectory');

      // The package's own source repo is never prompted (its files are the source).
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'github-delivery-os' }, null, 2));
      assert.equal(runSnippet(shell, repo, cache).stderr, '');
      fs.rmSync(path.join(repo, 'package.json'));

      const notRepo = mkTmp();
      try {
        assert.equal(runSnippet(shell, notRepo, cache).stderr, '');
      } finally {
        rm(notRepo);
      }
    } finally {
      rm(repo);
      rm(cache);
    }
  });
}

test('shell snippet (bash): the prompt hook hands back the last command\'s exit status (review: it reset $? to 0)', () => {
  if (!hasCommand('bash')) return;
  const dir = mkTmp();
  try {
    const script = `${shellTest.buildSnippet('bash')}\n__delivery_os_prompt() { :; }\n`;
    // Source the real wrapper (not the stub above): pull it out of an interactive-only block.
    const wrapper = shellTest.buildSnippet('bash').match(/ {2}__delivery_os_prompt\(\) \{[\s\S]*?\n {2}\}/)[0];
    const r = spawnSync('bash', ['-c', `${script}\n${wrapper}\ncd "${dir}"; false; __delivery_os_prompt; echo "ec=$?"; (exit 3); __delivery_os_prompt; echo "ec=$?"`], {
      env: { ...process.env, XDG_CACHE_HOME: dir, HOME: dir },
      encoding: 'utf8',
    });
    assert.match(r.stdout, /ec=1\nec=3/);
  } finally {
    rm(dir);
  }
});

test('shell snippet (zsh): cd inside $(...) never leaks the reminder into captured output (review: chpwd runs in subshells)', () => {
  if (!hasCommand('zsh') || !hasCommand('git')) return;
  const repo = mkTmp();
  const cache = mkTmp();
  try {
    execFileSync('git', ['init', '-q', repo]);
    writeManifestVersion(repo, '1.8.0');
    seedCache(cache, '1.9.0');
    const r = spawnSync('zsh', ['-f', '-i', '-c', `${shellTest.buildSnippet('zsh')}\nx=$(cd "${repo}" && echo done); print -r -- "captured=$x"`], {
      env: { ...process.env, XDG_CACHE_HOME: cache, HOME: cache },
      encoding: 'utf8',
    });
    assert.match(r.stdout, /captured=done$/m);
    assert.match(r.stderr, /1\.8\.0 installed/);
  } finally {
    rm(repo);
    rm(cache);
  }
});

test('shell-hook: bash on macOS goes in ~/.bash_profile (login shells skip ~/.bashrc)', () => {
  assert.equal(path.basename(shellTest.rcFile('bash', {}, 'darwin')), '.bash_profile');
  assert.equal(path.basename(shellTest.rcFile('bash', {}, 'linux')), '.bashrc');
  assert.equal(shellTest.rcFile('zsh', { ZDOTDIR: '/z' }, 'darwin'), path.join('/z', '.zshrc'));
});

test('shell-hook: --install with --uninstall is an error, not a silent uninstall', () => {
  const { runShellHook } = require('../src/shell-hook');
  assert.throws(() => runShellHook({ shell: 'zsh', install: true, uninstall: true }), /either --install or --uninstall/);
});

test('update hook: silent in the package\'s own source repo (review: it offered to overwrite the source)', () => {
  const repo = mkTmp();
  const cache = mkTmp();
  try {
    seedCache(cache, '9.9.9');
    writeManifestVersion(repo, '1.0.0');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'github-delivery-os' }));
    assert.equal(runHookScript(repo, cache).stdout, '');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'some-app' }));
    assert.match(runHookScript(repo, cache).stdout, /1\.0\.0 installed/);
  } finally {
    rm(repo);
    rm(cache);
  }
});

test('update hook: offline with a stale cache re-stamps it, so the next session doesn\'t wait on npm again', async () => {
  const dir = mkTmp();
  try {
    const file = seedCache(dir, '1.8.0', hook.CACHE_TTL_MS + 60000);
    assert.equal(await hook.latestVersion({ file, fetch: async () => null }), '1.8.0');
    let fetched = false;
    await hook.latestVersion({ file, fetch: async () => { fetched = true; return '1.9.0'; } });
    assert.equal(fetched, false, 'backed off for a day');
  } finally {
    rm(dir);
  }
});

test('update hook: suggested command matches status\'s buildUpdateCommand (they are separate copies)', () => {
  const dir = mkTmp();
  try {
    const { buildUpdateCommand } = installTest;
    const setTemplates = (on) =>
      on
        ? (fs.mkdirSync(path.join(dir, '.github', 'ISSUE_TEMPLATE'), { recursive: true }),
          fs.writeFileSync(path.join(dir, '.github', 'ISSUE_TEMPLATE', 'task.yml'), ''))
        : fs.rmSync(path.join(dir, '.github'), { recursive: true, force: true });
    const setSkill = (on) =>
      on
        ? (fs.mkdirSync(path.dirname(skillPath(dir)), { recursive: true }), fs.writeFileSync(skillPath(dir), ''))
        : fs.rmSync(path.join(dir, '.claude'), { recursive: true, force: true });
    for (const hasTemplates of [false, true]) {
      for (const hasSkill of [false, true]) {
        setTemplates(hasTemplates);
        setSkill(hasSkill);
        assert.equal(hook.updateCommand(dir), buildUpdateCommand({ hasTemplates, hasSkill }));
      }
    }
  } finally {
    rm(dir);
  }
});

test('--update and uninstall touch only our command, not a user hook sharing its entry (review: whole entry was replaced/removed)', () => {
  const dir = mkTmp();
  try {
    const mine = { type: 'command', command: 'echo mine' };
    const shared = { matcher: 'startup', hooks: [{ type: 'command', command: 'node old/delivery-os-update-check.js' }, mine] };
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS_REL_PATH), JSON.stringify({ hooks: { SessionStart: [shared] } }));

    assert.equal(registerUpdateHook(dir, { overwrite: true, dryRun: false }), 'updated');
    assert.deepEqual(readSettingsFile(dir).hooks.SessionStart, [{ matcher: 'startup', hooks: [mine] }, UPDATE_HOOK_ENTRY]);

    assert.equal(installTest.unregisterUpdateHook(dir, { dryRun: false }), true);
    assert.deepEqual(readSettingsFile(dir).hooks.SessionStart, [{ matcher: 'startup', hooks: [mine] }]);
  } finally {
    rm(dir);
  }
});

test('a hand-written SessionStart that isn\'t a list is left untouched (review: it was silently replaced)', () => {
  const dir = mkTmp();
  try {
    const content = JSON.stringify({ hooks: { SessionStart: { matcher: 'startup', hooks: [] } } });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS_REL_PATH), content);
    assert.match(registerUpdateHook(dir, { overwrite: true, dryRun: false }), /^error: "hooks.SessionStart" is not a list/);
    assert.equal(fs.readFileSync(path.join(dir, SETTINGS_REL_PATH), 'utf8'), content);
  } finally {
    rm(dir);
  }
});
