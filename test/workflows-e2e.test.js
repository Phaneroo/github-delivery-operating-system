'use strict';

// The real inline scripts of authorize-deployment.yml and auto-close-sprint.yml,
// run against the in-memory fake GitHub API (see fake-github.js).

const assert = require('assert/strict');
const { test } = require('./harness');
const { extractScript, createFakeRepo, runScript, repo } = require('./fake-github');
const { AUTO_CLOSE_COMMENT } = require('../.github/scripts/auto-close-sprint');

const AUTHORIZE = extractScript('authorize-deployment.yml', 'authorize');
const SPRINT = extractScript('auto-close-sprint.yml', 'update-sprint');

// ---------------------------------------------------------------------------
// authorize-deployment.yml
// ---------------------------------------------------------------------------

const RELEASE_ENV = { RELEASE_APPROVER: 'relA, relB', QA_APPROVER: 'qaA, qaB', DELIVERY_OS_AUTO_CLOSE: 'false' };
const by = (login, body) => ({ issue_number: 7, user: { login }, body });

function release(comments, labels = ['release', 'production', 'approval']) {
  return createFakeRepo({
    issues: [{ number: 7, title: 'PRODUCTION RELEASE', labels, created_at: '2026-09-20T00:00:00Z' }],
    comments,
  });
}
async function authorize(fx, extraEnv = {}) {
  const context = { eventName: 'issue_comment', repo, issue: { number: 7 }, payload: { issue: { number: 7 } } };
  await runScript(AUTHORIZE, { github: fx.github, context, env: { ...RELEASE_ENV, ...extraEnv } });
  return { labels: fx.store.issues[0].labels.map((l) => (typeof l === 'string' ? l : l.name)), comments: fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]') };
}

test('release flow: release approval + QA approval authorizes the deployment', async () => {
  const { labels, comments } = await authorize(release([by('relA', 'approved'), by('qaA', 'qa ok')]));
  assert.ok(labels.includes('ready-for-deploy'));
  assert.match(comments[0].body, /Deployment Authorized/);
});

test('release flow: the release approver alone authorizes when DELIVERY_OS_QA_REQUIRED=false (solo repos)', async () => {
  const { labels, comments } = await authorize(release([by('relA', 'approved')]), { DELIVERY_OS_QA_REQUIRED: 'false' });
  assert.ok(labels.includes('ready-for-deploy'));
  assert.match(comments[0].body, /Release approval received/);
});

test('release flow: without DELIVERY_OS_QA_REQUIRED=false the release approval alone still waits for QA', async () => {
  const { labels } = await authorize(release([by('relA', 'approved')]));
  assert.ok(!labels.includes('ready-for-deploy'));
});

test('release flow: a QA decline still blocks even when QA is not required', async () => {
  const { labels } = await authorize(release([by('relA', 'approved'), by('qaA', 'declined')]), { DELIVERY_OS_QA_REQUIRED: 'false' });
  assert.ok(labels.includes('declined'));
  assert.ok(!labels.includes('ready-for-deploy'));
});

test('release flow: a QA approver\'s decline blocks the release and removes ready-for-deploy', async () => {
  const fx = release([by('relA', 'approved'), by('qaA', 'qa ok')]);
  await authorize(fx);
  fx.store.comments.push(by('qaB', 'qa declined - payment page broken'));
  const { labels, comments } = await authorize(fx);
  assert.ok(labels.includes('declined'));
  assert.ok(!labels.includes('ready-for-deploy'));
  assert.match(comments[comments.length - 1].body, /Declined by QA/);
});

test('release flow: another QA approver cannot lift a QA decline; the decliner can', async () => {
  const fx = release([by('relA', 'approved'), by('qaA', 'declined')]);
  await authorize(fx);
  fx.store.comments.push(by('qaB', 'qa ok'));
  let r = await authorize(fx);
  assert.ok(r.labels.includes('declined'));
  assert.ok(!r.labels.includes('ready-for-deploy'));
  fx.store.comments.push(by('qaA', 'qa approved'));
  r = await authorize(fx);
  assert.ok(!r.labels.includes('declined'));
  assert.ok(r.labels.includes('ready-for-deploy'));
});

test('release flow: another release approver cannot lift a release decline', async () => {
  const fx = release([by('relA', 'declined'), by('relB', 'approved'), by('qaA', 'qa ok')]);
  const r = await authorize(fx);
  assert.ok(r.labels.includes('declined'));
  assert.ok(!r.labels.includes('ready-for-deploy'));
  assert.match(r.comments[0].body, /Only the release approver who declined it can lift the decline/);
});

test('release flow: the decliner approving before QA signs off clears the `declined` label straight away', async () => {
  const fx = release([by('relA', 'declined')]);
  let r = await authorize(fx);
  assert.ok(r.labels.includes('declined'));
  fx.store.comments.push(by('relA', 'approved'));
  r = await authorize(fx);
  assert.ok(!r.labels.includes('declined'), 'stale label must go');
  assert.ok(!r.labels.includes('ready-for-deploy'), 'QA has not signed off yet');
});

test('release flow: routine discussion does nothing', async () => {
  const fx = release([by('relA', 'thanks, looking at it'), by('someone', 'approved')]);
  const r = await authorize(fx);
  assert.deepEqual(r.labels, ['release', 'production', 'approval']);
  assert.equal(r.comments.length, 0);
});

// ---------------------------------------------------------------------------
// auto-close-sprint.yml
// ---------------------------------------------------------------------------

const SPRINT_BODY = '### Sprint Start\n\n2026-09-01\n\n### Sprint End\n\n2026-09-30\n';
const child = (number, parent, extra = {}) => ({ number, title: `task ${number}`, body: `Parent Sprint: #${parent}\n\n---`, labels: ['sprint-child'], ...extra });

function sprintRepo(children, sprintExtra = {}) {
  return createFakeRepo({ issues: [{ number: 5, title: 'SPRINT - 5', labels: ['sprint'], body: SPRINT_BODY, ...sprintExtra }, ...children] });
}
async function sprintEvent(fx, action, childNumber) {
  const issue = fx.store.issues.find((i) => i.number === childNumber);
  const context = { eventName: 'issues', repo, payload: { action, issue: { number: issue.number, body: issue.body } } };
  await runScript(SPRINT, { github: fx.github, context, env: {} });
  return fx.store.issues.find((i) => i.number === 5);
}

test('sprint flow: the sprint closes itself when its last child closes, once', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'closed', state_reason: 'completed' }), child(7, 5, { state: 'closed', state_reason: 'completed' })]);
  let sprint = await sprintEvent(fx, 'closed', 7);
  assert.equal(sprint.state, 'closed');
  assert.equal(fx.store.comments.filter((c) => c.body === AUTO_CLOSE_COMMENT).length, 1);
  sprint = await sprintEvent(fx, 'closed', 6); // a later event on an already-closed sprint
  assert.equal(fx.store.comments.filter((c) => c.body === AUTO_CLOSE_COMMENT).length, 1, 'no duplicate completion comment');
});

test('sprint flow: children of a different sprint whose number starts with this one do not count', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'closed', state_reason: 'completed' }), child(8, 57, { state: 'open' })]);
  const sprint = await sprintEvent(fx, 'closed', 6);
  assert.equal(sprint.state, 'closed', '#8 belongs to sprint #57');
});

test('sprint flow: a task closed as "not planned" leaves the count instead of counting as done', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'closed', state_reason: 'completed' }), child(7, 5, { state: 'closed', state_reason: 'not_planned' }), child(8, 5, { state: 'open' })]);
  let sprint = await sprintEvent(fx, 'closed', 7);
  assert.equal(sprint.state, 'open');
  assert.match(sprint.body, /Progress: \*\*50%\*\*/, '1 done of 2 real tasks, not 2 of 3');
  fx.store.issues.find((i) => i.number === 8).state = 'closed';
  fx.store.issues.find((i) => i.number === 8).state_reason = 'completed';
  sprint = await sprintEvent(fx, 'closed', 8);
  assert.equal(sprint.state, 'closed');
});

test('sprint flow: reopening a child of a sprint that closed itself reopens the sprint', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'closed', state_reason: 'completed' })]);
  await sprintEvent(fx, 'closed', 6);
  assert.equal(fx.store.issues.find((i) => i.number === 5).state, 'closed');
  const kid = fx.store.issues.find((i) => i.number === 6);
  kid.state = 'open';
  const sprint = await sprintEvent(fx, 'reopened', 6);
  assert.equal(sprint.state, 'open');
  assert.match(sprint.body, /Progress: \*\*0%\*\*/);
  assert.match(fx.store.comments[fx.store.comments.length - 1].body, /Sprint reopened: #6 was reopened/);
});

test('sprint flow: reopening a child leaves a sprint someone closed by hand alone', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'open' })], { state: 'closed' });
  const sprint = await sprintEvent(fx, 'reopened', 6);
  assert.equal(sprint.state, 'closed');
  assert.equal(fx.store.comments.length, 0);
});

test('sprint flow: reopening a child of an open sprint just refreshes the burn-down', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'closed', state_reason: 'completed' }), child(7, 5, { state: 'open' })]);
  const sprint = await sprintEvent(fx, 'reopened', 7);
  assert.equal(sprint.state, 'open');
  assert.match(sprint.body, /Progress: \*\*50%\*\*/);
  assert.equal(fx.store.comments.length, 0);
});

test('sprint flow: a sprint auto-closed earlier but closed by hand since is not reopened by a reopened task', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'closed', state_reason: 'completed' })]);
  await sprintEvent(fx, 'closed', 6); // auto-closes
  const sprint = fx.store.issues.find((i) => i.number === 5);
  sprint.state = 'open'; // a task was reopened earlier and the sprint reopened
  fx.store.issues.find((i) => i.number === 6).state = 'open';
  await sprintEvent(fx, 'reopened', 6);
  sprint.state = 'closed'; // ...then someone closes the sprint by hand, much later
  sprint.closed_at = '2027-01-01T00:00:00Z';
  const kid = fx.store.issues.find((i) => i.number === 6);
  kid.state = 'closed';
  kid.state = 'open';
  const after = await sprintEvent(fx, 'reopened', 6);
  assert.equal(after.state, 'closed');
});

test('sprint flow: unreadable sprint dates do not stop the burn-down, auto-close or reopen', async () => {
  const fx = sprintRepo([child(6, 5, { state: 'closed', state_reason: 'completed' })], { body: 'no dates here' });
  const sprint = await sprintEvent(fx, 'closed', 6);
  assert.equal(sprint.state, 'closed');
  assert.match(sprint.body, /Progress: \*\*100%\*\*/);
  fx.store.issues.find((i) => i.number === 6).state = 'open';
  const reopened = await sprintEvent(fx, 'reopened', 6);
  assert.equal(reopened.state, 'open');
});
