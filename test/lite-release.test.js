'use strict';

// The lite bundle's own authorize-deployment workflow, run for real against a
// fake repo: one release approver, no QA approver.

const assert = require('assert/strict');
const { test } = require('./harness');
const { extractScript, createFakeRepo, runScript, repo } = require('./fake-github');

const LITE_AUTHORIZE = extractScript('authorize-deployment.yml', 'authorize', require('path').join('.github', 'lite', 'workflows'));
const ENV = { RELEASE_APPROVER: 'me', DELIVERY_OS_AUTO_CLOSE: 'false' };
const by = (login, body) => ({ issue_number: 7, user: { login }, body });

function release(comments, labels = ['release', 'production', 'approval']) {
  return createFakeRepo({
    issues: [{ number: 7, title: 'PRODUCTION RELEASE', labels, created_at: '2026-09-20T00:00:00Z' }],
    comments,
  });
}
async function authorize(fx) {
  const context = { eventName: 'issue_comment', repo, issue: { number: 7 }, payload: { issue: { number: 7 } } };
  await runScript(LITE_AUTHORIZE, { github: fx.github, context, env: ENV });
  return {
    labels: fx.store.issues[0].labels.map((l) => (typeof l === 'string' ? l : l.name)),
    comments: fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]'),
  };
}

test('lite release: the release approver alone authorizes the release', async () => {
  const { labels, comments } = await authorize(release([by('me', 'approved')]));
  assert.ok(labels.includes('ready-for-deploy'));
  assert.match(comments[0].body, /Deployment Authorized/);
  assert.match(comments[0].body, /Release approval received/);
});

test('lite release: a comment from anyone else does nothing', async () => {
  const { labels, comments } = await authorize(release([by('stranger', 'approved')]));
  assert.ok(!labels.includes('ready-for-deploy'));
  assert.equal(comments.length, 0);
});

test('lite release: routine discussion from the approver does nothing', async () => {
  const { labels, comments } = await authorize(release([by('me', 'checking the staging build first')]));
  assert.ok(!labels.includes('ready-for-deploy'));
  assert.equal(comments.length, 0);
});

test('lite release: a decline blocks it, and approving again lifts the decline and authorizes', async () => {
  const fx = release([by('me', 'declined - login is broken')]);
  let r = await authorize(fx);
  assert.ok(r.labels.includes('declined'));
  assert.ok(!r.labels.includes('ready-for-deploy'));
  assert.match(r.comments[r.comments.length - 1].body, /Release Declined/);

  fx.store.comments.push(by('me', 'approved'));
  r = await authorize(fx);
  assert.ok(!r.labels.includes('declined'));
  assert.ok(r.labels.includes('ready-for-deploy'));
});

test('lite release: authorizing is announced once, not on every later comment', async () => {
  const fx = release([by('me', 'approved')]);
  await authorize(fx);
  fx.store.comments.push(by('me', 'approved, thanks'));
  const { comments } = await authorize(fx);
  assert.equal(comments.filter((c) => /Deployment Authorized/.test(c.body)).length, 1);
});
