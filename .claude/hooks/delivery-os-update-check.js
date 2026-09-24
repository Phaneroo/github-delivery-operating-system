#!/usr/bin/env node
'use strict';

// Claude Code SessionStart hook, installed by `install --with-skill` and
// registered in .claude/settings.json. When a session starts in a repo whose
// Delivery OS install (.github/delivery-os.json) is behind the latest
// published version, it tells the user and asks Claude to offer the update —
// never runs it, since the update rewrites the repo's workflow/template files.
//
// Self-contained on purpose: it runs from the consumer repo, where this
// package isn't installed, so it can't require() anything from it. Silent on
// every failure (no manifest, offline, bad cache) and always exits 0, so it
// can never get in the way of starting a session.
//
// The latest version is cached for a day in a plain-text file shared with the
// terminal hook (`delivery-os shell-hook`), so opening a repo stays instant.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;
const REGISTRY_URL = 'https://registry.npmjs.org/github-delivery-os/latest';

// Same list as TEMPLATES in src/install.js (a test keeps them equal) — used
// only to decide whether the suggested update command needs --with-templates.
const TEMPLATES = [
  'config.yml',
  'sprint_planning.yml',
  'task.yml',
  'qa_request.yml',
  'production_release_qa_signoff.yml',
  'bug_report.yml',
];
const SKILL_REL_PATH = path.join('.claude', 'skills', 'delivery-ops', 'SKILL.md');

function cacheFile(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'github-delivery-os', 'latest-version');
}

function readInstalledVersion(repoDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, '.github', 'delivery-os.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

// Numeric x.y.z comparison: true when `version` is older than `than`.
function isOlderVersion(version, than) {
  const a = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(than).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

// { version, fresh } from the cache file, or null if it's missing/unreadable.
function readCache(file, now = Date.now()) {
  try {
    const version = fs.readFileSync(file, 'utf8').trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) return null;
    return { version, fresh: now - fs.statSync(file).mtimeMs < CACHE_TTL_MS };
  } catch {
    return null;
  }
}

function writeCache(file, version) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${version}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // A read-only home just means no caching — the check still works.
  }
}

function fetchLatestVersion(timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = https.get(REGISTRY_URL, { headers: { 'User-Agent': 'github-delivery-os-update-check' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done(null);
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          done(JSON.parse(data).version || null);
        } catch {
          done(null);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => done(null));
  });
}

// A fresh cache wins; otherwise ask npm and cache the answer. If npm can't be
// reached, a stale cached value is still better than nothing.
async function latestVersion({ file = cacheFile(), fetch = fetchLatestVersion, now = Date.now() } = {}) {
  const cached = readCache(file, now);
  if (cached && cached.fresh) return cached.version;
  const fetched = await fetch();
  if (fetched) {
    writeCache(file, fetched);
    return fetched;
  }
  return cached ? cached.version : null;
}

// Mirrors buildUpdateCommand in src/install.js: templates/skill flags only
// when they're installed, so the recorded version actually advances.
function updateCommand(repoDir) {
  const hasTemplates = TEMPLATES.some((t) => fs.existsSync(path.join(repoDir, '.github', 'ISSUE_TEMPLATE', t)));
  const hasSkill = fs.existsSync(path.join(repoDir, SKILL_REL_PATH));
  const flags = [hasTemplates ? '--with-templates' : null, hasSkill ? '--with-skill' : null, '--with-labels', '--update']
    .filter(Boolean)
    .join(' ');
  return `npx github-delivery-os@latest install ${flags} .`;
}

// The hook's JSON output, or null when there's nothing to say.
function buildOutput(installed, latest, command) {
  if (!installed || !latest || !isOlderVersion(installed, latest)) return null;
  return {
    systemMessage: `Delivery OS ${installed} installed, ${latest} available. Update: ${command}`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `This repo's GitHub Delivery OS install is out of date: ${installed} is installed ` +
        `(.github/delivery-os.json) and ${latest} is the latest published version. ` +
        `Early in the session, briefly offer to update it by running \`${command}\` from the repo root. ` +
        'Only run it after the user explicitly confirms: it rewrites the Delivery OS workflow and ' +
        'template files, and the result should go through the repo\'s normal review (branch + PR).',
    },
  };
}

async function main() {
  const repoDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const installed = readInstalledVersion(repoDir);
  if (!installed) return;
  const latest = await latestVersion();
  const output = buildOutput(installed, latest, updateCommand(repoDir));
  if (output) process.stdout.write(JSON.stringify(output) + '\n');
}

if (require.main === module) {
  main().catch(() => {}).finally(() => process.exit(0));
}

module.exports = {
  CACHE_TTL_MS,
  TEMPLATES,
  cacheFile,
  readInstalledVersion,
  isOlderVersion,
  readCache,
  writeCache,
  latestVersion,
  updateCommand,
  buildOutput,
};
