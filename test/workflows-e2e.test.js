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
async function authorize(fx) {
  const context = { eventName: 'issue_comment', repo, issue: { number: 7 }, payload: { issue: { number: 7 } } };
  await runScript(AUTHORIZE, { github: fx.github, context, env: RELEASE_ENV });
  return { labels: fx.store.issues[0].labels.map((l) => (typeof l === 'string' ? l : l.name)), comments: fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]') };
}

test('release flow: release approval + QA approval authorizes the deployment', async () => {
  const { labels, comments } = await authorize(release([by('relA', 'approved'), by('qaA', 'qa ok')]));
  assert.ok(labels.includes('ready-for-deploy'));
  assert.match(comments[0].body, /Deployment Authorized/);
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

// ---------------------------------------------------------------------------
// feature-approval.yml
// ---------------------------------------------------------------------------

const FEATURE = extractScript('feature-approval.yml', 'verdict');

async function featureVerdict(login, body, { labels = ['feature', 'needs-approval'], approver = 'apprA, apprB' } = {}) {
  const fx = createFakeRepo({ issues: [{ number: 9, title: '[FEATURE] x', labels, created_at: '2026-09-20T00:00:00Z' }] });
  const context = { repo, payload: { issue: { number: 9 }, comment: { user: { login }, body } } };
  await runScript(FEATURE, { github: fx.github, context, env: { FEATURE_APPROVER: approver } });
  return {
    labels: fx.store.issues[0].labels.map((l) => (typeof l === 'string' ? l : l.name)).sort(),
    comments: fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]'),
    state: fx.store.issues[0].state,
  };
}

test('feature flow: the approver approving swaps needs-approval for approved and leaves the issue open', async () => {
  const r = await featureVerdict('apprA', 'approved');
  assert.deepEqual(r.labels, ['approved', 'feature']);
  assert.match(r.comments[0].body, /Feature approved/);
  assert.equal(r.state, 'open');
});

test('feature flow: a ✅ from an approver approves, a ❌ declines', async () => {
  assert.deepEqual((await featureVerdict('apprB', '✅')).labels, ['approved', 'feature']);
  const d = await featureVerdict('apprA', '❌ missing edge cases');
  assert.deepEqual(d.labels, ['declined', 'feature']);
  assert.match(d.comments[0].body, /Feature declined/);
});

test('feature flow: approving lifts an earlier decline', async () => {
  const r = await featureVerdict('apprA', 'go ahead', { labels: ['feature', 'declined'] });
  assert.deepEqual(r.labels, ['approved', 'feature']);
});

test('feature flow: a non-approver, or ordinary discussion, changes nothing', async () => {
  for (const [login, body] of [['dev', 'approved'], ['apprA', 'can you add a note on rollout?']]) {
    const r = await featureVerdict(login, body);
    assert.deepEqual(r.labels, ['feature', 'needs-approval']);
    assert.equal(r.comments.length, 0);
  }
});

test('feature flow: a repeat approval does not announce twice', async () => {
  const r = await featureVerdict('apprA', 'approved', { labels: ['feature', 'approved'] });
  assert.equal(r.comments.length, 0);
});

test('feature flow: "ok, but ..." and "approve of the idea, but ..." in a discussion do not approve; a bare "ok" does', async () => {
  for (const body of ['Ok, can you clarify requirement 3?', 'Approve of the idea, but acceptance criteria are missing']) {
    const r = await featureVerdict('apprA', body);
    assert.deepEqual(r.labels, ['feature', 'needs-approval'], body);
  }
  assert.deepEqual((await featureVerdict('apprA', 'ok')).labels, ['approved', 'feature']);
  assert.deepEqual((await featureVerdict('apprA', 'Approved, ship it')).labels, ['approved', 'feature']);
});

async function featureThread(comments, labels) {
  const fx = createFakeRepo({
    issues: [{ number: 9, title: '[FEATURE] x', labels, created_at: '2026-09-20T00:00:00Z' }],
    comments: comments.slice(0, -1).map(([login, body]) => ({ issue_number: 9, user: { login }, body })),
  });
  const [login, body] = comments[comments.length - 1];
  fx.store.comments.push({ issue_number: 9, user: { login }, body });
  const context = { repo, payload: { issue: { number: 9 }, comment: { user: { login }, body } } };
  await runScript(FEATURE, { github: fx.github, context, env: { FEATURE_APPROVER: 'apprA, apprB' } });
  return {
    labels: fx.store.issues[0].labels.map((l) => (typeof l === 'string' ? l : l.name)).sort(),
    bot: fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]'),
  };
}

test('feature flow: with two approvers, a decline stands until the decliner approves', async () => {
  const blocked = await featureThread([['apprA', 'declined'], ['apprB', 'approved']], ['feature', 'declined']);
  assert.deepEqual(blocked.labels, ['declined', 'feature']);
  assert.match(blocked.bot[0].body, /declined by @apprA/);
  const lifted = await featureThread([['apprA', 'declined'], ['apprB', 'approved'], ['apprA', 'approved']], ['feature', 'declined']);
  assert.deepEqual(lifted.labels, ['approved', 'feature']);
});

test('feature flow: the verdict label is added before the old ones are removed', async () => {
  const fx = createFakeRepo({ issues: [{ number: 9, title: '[FEATURE] x', labels: ['feature', 'needs-approval'], created_at: '2026-09-20T00:00:00Z' }] });
  const calls = [];
  const gh = { ...fx.github, rest: { ...fx.github.rest, issues: { ...fx.github.rest.issues,
    addLabels: async (a) => { calls.push('add'); return fx.github.rest.issues.addLabels(a); },
    removeLabel: async (a) => { calls.push('remove'); return fx.github.rest.issues.removeLabel(a); } } } };
  gh.paginate = fx.github.paginate;
  const context = { repo, payload: { issue: { number: 9 }, comment: { user: { login: 'apprA' }, body: 'approved' } } };
  await runScript(FEATURE, { github: gh, context, env: { FEATURE_APPROVER: 'apprA' } });
  assert.deepEqual(calls, ['add', 'remove']);
});

test('feature flow: only open issues are acted on', () => {
  const yml = require('fs').readFileSync(require('path').join(__dirname, '..', '.github', 'workflows', 'feature-approval.yml'), 'utf8');
  assert.match(yml, /github\.event\.issue\.state == 'open'/);
});

// feature-approval: notify and re-review

const FEATURE_NOTIFY = extractScript('feature-approval.yml', 'notify');

async function notifyFeature(approver) {
  const fx = createFakeRepo({ issues: [{ number: 9, title: '[FEATURE] x', labels: ['feature', 'needs-approval'], created_at: '2026-09-20T00:00:00Z' }] });
  const context = { repo, payload: { issue: { number: 9 } } };
  await runScript(FEATURE_NOTIFY, { github: fx.github, context, env: { FEATURE_APPROVER: approver } });
  return fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]');
}

test('feature notify: a new Feature Request pings every feature approver', async () => {
  const [c] = await notifyFeature('apprA, @apprB');
  assert.match(c.body, /@apprA @apprB/);
  assert.match(c.body, /waiting for your approval/);
});

test('feature notify: with FEATURE_APPROVER unset it says so, and does not fall back to the release approver', async () => {
  const [c] = await notifyFeature('');
  assert.match(c.body, /`FEATURE_APPROVER` is not set/);
  assert.match(c.body, /separate from `RELEASE_APPROVER`/);
});

async function rereview(login, body, { labels = ['feature', 'declined'], author = 'dev', approver = 'apprA' } = {}) {
  const fx = createFakeRepo({ issues: [{ number: 9, title: '[FEATURE] x', labels, created_at: '2026-09-20T00:00:00Z' }] });
  const context = { repo, payload: { issue: { number: 9, user: { login: author } }, comment: { user: { login }, body } } };
  await runScript(FEATURE, { github: fx.github, context, env: { FEATURE_APPROVER: approver } });
  return {
    labels: fx.store.issues[0].labels.map((l) => (typeof l === 'string' ? l : l.name)).sort(),
    bot: fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]'),
  };
}

test('feature re-review: the author commenting "ready for review" after a decline re-queues it and pings the approver', async () => {
  const r = await rereview('dev', 'Ready for review: added the edge cases');
  assert.deepEqual(r.labels, ['feature', 'needs-approval']);
  assert.match(r.bot[0].body, /@apprA please take another look/);
});

test('feature re-review: someone else, an ordinary reply, or a feature that is not declined changes nothing', async () => {
  for (const [login, body, opts] of [
    ['stranger', 'ready for review', {}],
    ['dev', 'I updated the requirements', {}],
    ['dev', 'ready for review', { labels: ['feature', 'needs-approval'] }],
    ['dev', 'ready for review', { labels: ['feature', 'approved'] }],
  ]) {
    const before = opts.labels || ['feature', 'declined'];
    const r = await rereview(login, body, opts);
    assert.deepEqual(r.labels, [...before].sort(), `${login}: ${body}`);
    assert.equal(r.bot.length, 0);
  }
});

test('feature approval: with FEATURE_APPROVER unset nobody can approve, even a release approver', async () => {
  const r = await featureVerdict('release-approver', 'approved', { approver: '' });
  assert.deepEqual(r.labels, ['feature', 'needs-approval']);
});

test('feature approval: the workflow no longer reads RELEASE_APPROVER', () => {
  const yml = require('fs').readFileSync(require('path').join(__dirname, '..', '.github', 'workflows', 'feature-approval.yml'), 'utf8');
  assert.doesNotMatch(yml, /vars\.RELEASE_APPROVER/);
});

// feature-approval: review follow-ups

const FEATURE_YML = require('fs').readFileSync(require('path').join(__dirname, '..', '.github', 'workflows', 'feature-approval.yml'), 'utf8');

async function featureRun(job, { comments = [], labels = ['feature'], author = 'dev', approver = 'apprA, apprB', actor = 'dev', body = '' } = {}) {
  const fx = createFakeRepo({ issues: [{ number: 9, title: '[FEATURE] x', labels, created_at: '2026-09-20T00:00:00Z' }], comments: comments.map(([login, text]) => ({ issue_number: 9, user: { login }, body: text })) });
  if (job === 'verdict') fx.store.comments.push({ issue_number: 9, user: { login: actor }, body });
  const context = { repo, payload: { issue: { number: 9, user: { login: author } }, comment: { user: { login: actor }, body } } };
  await runScript(job === 'notify' ? FEATURE_NOTIFY : FEATURE, { github: fx.github, context, env: { FEATURE_APPROVER: approver } });
  return {
    labels: fx.store.issues[0].labels.map((l) => (typeof l === 'string' ? l : l.name)).sort(),
    bot: fx.store.comments.filter((c) => c.user.login === 'github-actions[bot]'),
  };
}

test('feature re-review: after a re-queue, a different approver can approve despite the first approver\'s old decline', async () => {
  // alice declined, the author asked for review (the bot's 🔁 comment), bob approves
  const r = await featureRun('verdict', {
    approver: 'alice, bob', actor: 'bob', body: 'approved', labels: ['feature', 'needs-approval'],
    comments: [['alice', 'declined'], ['github-actions[bot]', '🔁 @dev asked for another review. @alice @bob please take another look.']],
  });
  assert.deepEqual(r.labels, ['approved', 'feature']);
});

test('feature re-review: a decline before the re-queue still blocks if there was no re-queue', async () => {
  const r = await featureRun('verdict', { approver: 'alice, bob', actor: 'bob', body: 'approved', labels: ['feature', 'declined'], comments: [['alice', 'declined']] });
  assert.deepEqual(r.labels, ['declined', 'feature']);
  assert.match(r.bot[0].body, /declined by @alice/);
});

test('feature re-review: questions, conditions and approvers do not re-queue; only the author, plainly, does', async () => {
  for (const [actor, body] of [
    ['dev', 'Ready for review? I am still unsure about the tests'],
    ['dev', 'ready for review once the API lands'],
    ['apprA', 'ready for review'],
    ['stranger', 'ready for review'],
  ]) {
    const r = await featureRun('verdict', { labels: ['feature', 'declined'], actor, body });
    assert.deepEqual(r.labels, ['declined', 'feature'], `${actor}: ${body}`);
  }
  assert.deepEqual((await featureRun('verdict', { labels: ['feature', 'declined'], actor: 'dev', body: 'Ready for review: added edge cases' })).labels, ['feature', 'needs-approval']);
});

test('feature approval: with FEATURE_APPROVER unset, an approve comment gets one reply saying so', async () => {
  const first = await featureRun('verdict', { approver: '', actor: 'release-approver', body: 'approved', labels: ['feature', 'needs-approval'] });
  assert.deepEqual(first.labels, ['feature', 'needs-approval']);
  assert.match(first.bot[0].body, /`FEATURE_APPROVER` is not set/);
  const again = await featureRun('verdict', { approver: '', actor: 'release-approver', body: 'approved', labels: ['feature', 'needs-approval'], comments: [['github-actions[bot]', first.bot[0].body]] });
  assert.equal(again.bot.length, 1, 'only the earlier warning, no second one');
  assert.equal((await featureRun('verdict', { approver: '', actor: 'someone', body: 'sounds interesting' })).bot.length, 0, 'ordinary discussion is not answered');
});

test('feature notify: the second event for the same issue (opened + labeled) does not ping twice', async () => {
  const first = await featureRun('notify');
  assert.equal(first.bot.length, 1);
  const second = await featureRun('notify', { comments: [['github-actions[bot]', first.bot[0].body]] });
  assert.equal(second.bot.length, 1, 'still just the first ping');
});

test('feature notify: the author is never pinged about their own request', async () => {
  const [c] = (await featureRun('notify', { author: 'apprA', approver: 'apprA, apprB' })).bot;
  assert.match(c.body, /@apprB/);
  assert.doesNotMatch(c.body, /@apprA/);
  assert.equal((await featureRun('notify', { author: 'apprA', approver: 'apprA' })).bot.length, 0, 'the only approver is the author');
});

test('feature-approval.yml: notify runs for opened and for the feature label being added, verdict only for comments', () => {
  assert.match(FEATURE_YML, /types: \[opened, labeled\]/);
  assert.match(FEATURE_YML, /github\.event\.action == 'opened' \|\| github\.event\.label\.name == 'feature'/);
  assert.match(FEATURE_YML, /github\.event_name == 'issues' &&/);
  assert.match(FEATURE_YML, /github\.event_name == 'issue_comment' &&/);
  assert.match(FEATURE_YML, /feature-approval-notify-\$\{\{ github\.event\.issue\.number \}\}/);
});

test('feature re-review: with FEATURE_APPROVER unset, the re-queue comment says nobody can approve yet', async () => {
  const r = await featureRun('verdict', { approver: '', labels: ['feature', 'declined'], actor: 'dev', body: 'ready for review' });
  assert.deepEqual(r.labels, ['feature', 'needs-approval']);
  assert.match(r.bot[0].body, /^🔁 @dev asked for another review\. The repo variable `FEATURE_APPROVER` is not set, so nobody can approve it yet\./);
});
