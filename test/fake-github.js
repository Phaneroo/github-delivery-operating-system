'use strict';

// Runs a workflow's inline actions/github-script block against an in-memory
// fake of the GitHub API, so tests exercise the real workflow code (not just
// the pure functions it requires). Only the endpoints Delivery OS uses are
// implemented.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Pulls the `script: |` block of a job's github-script step out of a
 * workflow file by indentation (no YAML dependency).
 */
function extractScript(workflowFile, jobName) {
  const lines = fs.readFileSync(path.join(ROOT, '.github', 'workflows', workflowFile), 'utf8').split('\n');
  const jobLine = lines.findIndex((l) => l === `  ${jobName}:`);
  if (jobLine === -1) throw new Error(`job ${jobName} not found in ${workflowFile}`);
  const scriptLine = lines.findIndex((l, i) => i > jobLine && /^\s+script: \|\s*$/.test(l));
  const indent = lines[scriptLine].match(/^\s*/)[0].length;
  const body = [];
  for (let i = scriptLine + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break;
    body.push(l.slice(indent + 2));
  }
  return body.join('\n');
}

function createFakeRepo({ issues = [], pulls = {}, commits = {} } = {}) {
  const store = { issues: issues.map((i) => ({ state: 'open', state_reason: null, labels: [], body: '', ...i })), comments: [], nextNumber: 100 };
  for (const i of store.issues) store.nextNumber = Math.max(store.nextNumber, i.number + 1);
  let clock = Date.parse('2026-09-24T00:00:00Z');
  const now = () => new Date((clock += 1000)).toISOString();

  // A full PR object as the REST API returns it. `pulls[n]` may set
  // title/body/author/base/merged; merged PRs default to base `main`.
  const prObject = (n) => {
    const p = pulls[n] || {};
    return {
      number: n,
      title: p.title || `PR ${n}`,
      body: p.body || '',
      html_url: `https://github.com/o/r/pull/${n}`,
      user: { login: p.author || 'dev' },
      head: { ref: `branch-${n}` },
      base: { ref: p.base || 'main' },
      merged: Boolean(p.merged),
      merged_at: p.merged ? '2026-09-24T00:00:00Z' : null,
    };
  };
  const labelNames = (i) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));
  const find = (n) => {
    const issue = store.issues.find((i) => i.number === n);
    if (!issue) {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    }
    return issue;
  };
  const view = (i) => ({ ...i, labels: labelNames(i).map((name) => ({ name })) });

  const rest = {
    issues: {
      listForRepo: async ({ state = 'open', labels }) => {
        const wanted = labels ? labels.split(',') : [];
        return store.issues
          .filter((i) => state === 'all' || i.state === state)
          .filter((i) => wanted.every((l) => labelNames(i).includes(l)))
          .map(view);
      },
      get: async ({ issue_number }) => ({ data: view(find(issue_number)) }),
      create: async ({ title, body, labels }) => {
        const issue = { number: store.nextNumber++, title, body, labels: labels || [], state: 'open', state_reason: null, created_at: now() };
        store.issues.push(issue);
        return { data: view(issue) };
      },
      update: async ({ issue_number, ...fields }) => {
        const issue = find(issue_number);
        for (const k of ['title', 'body', 'state', 'state_reason']) if (k in fields) issue[k] = fields[k];
        if (fields.state === 'closed') issue.closed_at = now();
        if (fields.state === 'open') issue.state_reason = null;
        return { data: view(issue) };
      },
      createComment: async ({ issue_number, body }) => {
        store.comments.push({ issue_number, body });
        return { data: {} };
      },
      listComments: async () => [],
    },
    pulls: {
      listFiles: async ({ pull_number }) => (pulls[pull_number] || {}).files || [],
      listCommits: async ({ pull_number }) => ((pulls[pull_number] || {}).commits || []).map((m) => ({ commit: { message: m } })),
      get: async ({ pull_number }) => ({ data: prObject(pull_number) }),
    },
    repos: {
      compareCommitsWithBasehead: async ({ basehead }) => {
        const sha = basehead.split('...')[1];
        const c = commits[sha] || { files: [], messages: [] };
        return { data: { files: c.files.map((f) => ({ filename: f })), commits: c.messages.map((m) => ({ commit: { message: m } })) } };
      },
      getCommit: async ({ ref }) => {
        const c = commits[ref] || { files: [], messages: [''] };
        return { data: { files: c.files.map((f) => ({ filename: f })), commit: { message: c.messages[c.messages.length - 1] } } };
      },
      listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
        const c = commits[commit_sha] || {};
        if (c.lookupFails) throw new Error('Server Error');
        return { data: (c.prs || []).map(prObject) };
      },
    },
  };

  const github = {
    rest,
    paginate: async (fn, args) => {
      const result = await fn(args);
      return Array.isArray(result) ? result : result.data;
    },
  };

  return { github, store };
}

/**
 * Runs an inline script. setTimeout is made immediate so the rolling
 * issue's retry/race waits don't slow the suite.
 */
async function runScript(script, { github, context, env = {} }) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('github', 'context', 'core', 'require', 'process', 'console', script);
  const logs = [];
  const failures = [];
  const core = { setFailed: (m) => failures.push(m) };
  const fakeProcess = { env: { GITHUB_WORKSPACE: ROOT, ...env } };
  const fakeConsole = { log: (...a) => logs.push(a.join(' ')) };
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (cb) => realSetTimeout(cb, 0);
  try {
    await fn(github, context, core, require, fakeProcess, fakeConsole);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  return { logs, failures };
}

const repo = { owner: 'o', repo: 'r' };

/** A push-event context; `sha` must match an entry in the fake repo's `commits`. */
/** `author`: a GitHub login, or a commit author object ({ name, username? }). */
function pushContext(sha, headMessage, author = 'dev') {
  return {
    eventName: 'push',
    repo,
    sha,
    payload: {
      before: 'b'.repeat(40),
      head_commit: { message: headMessage, author: typeof author === 'string' ? { username: author, name: author } : author },
      commits: [{ message: headMessage }],
    },
  };
}

/** A pull_request-event context. */
function prContext(number, { action = 'opened', title = `PR ${number}`, body = '', merged = false, author = 'dev' } = {}) {
  return {
    eventName: 'pull_request',
    repo,
    payload: {
      action,
      pull_request: { number, title, body, html_url: `https://github.com/o/r/pull/${number}`, head: { ref: `branch-${number}` }, user: { login: author }, merged, draft: false },
    },
  };
}

module.exports = { extractScript, createFakeRepo, runScript, pushContext, prContext, repo };
