'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const { extractScript, createFakeRepo, runScript, pushContext, prContext, repo } = require('./fake-github');
const {
  resolveQaSettings,
  ROLLING_TITLE,
  ROLLING_FOOTER,
  APPROVAL_BOX,
  buildChangeLine,
  buildRollingQaBody,
  hasChange,
  appendChange,
  parseChanges,
  approvalBoxTicked,
  approvalBoxJustTicked,
  markRollingApproved,
  markRollingDeclined,
  untickApprovalBox,
} = require('../.github/scripts/auto-qa-request');
const {
  matchRollingQaVerdict,
  nextRollingQaAction,
  selectFilingsToCloseOnRelease,
  ROLLING_QA_APPROVE_PHRASES,
  ROLLING_QA_DECLINE_PHRASES,
  ROLLING_QA_APPROVE_EMOJI,
  ROLLING_QA_DECLINE_EMOJI,
  APPROVE_RE,
  DECLINE_RE,
  QA_APPROVE_RE,
} = require('../.github/scripts/authorize-deployment-verdict');

const FILE_SCRIPT = extractScript('auto-qa-request.yml', 'file-qa-request');
const APPROVAL_SCRIPT = extractScript('qa-rollup-approval.yml', 'verdict');
const ROLLING = ['qa-request', 'delivery-ops-filed', 'qa-rollup'];

const openRolling = (store) =>
  store.issues.filter((i) => i.state === 'open' && ROLLING.every((l) => i.labels.includes(l)));

// ---------------------------------------------------------------------------
// Settings back-compat
// ---------------------------------------------------------------------------

test('resolveQaSettings: rolling is the new default', () => {
  assert.deepEqual(resolveQaSettings(undefined, undefined), { style: 'rolling', prOnly: false });
  assert.deepEqual(resolveQaSettings('', ''), { style: 'rolling', prOnly: false });
});

test('resolveQaSettings: an explicit, valid DELIVERY_OS_AUTO_QA_MODE wins', () => {
  assert.equal(resolveQaSettings('per-change', undefined).style, 'per-change');
  assert.equal(resolveQaSettings(' OFF ', undefined).style, 'off');
  assert.equal(resolveQaSettings('rolling', 'all').style, 'rolling');
  assert.equal(resolveQaSettings('rolling', 'off').style, 'rolling');
});

test('resolveQaSettings: the 1.8.0 DELIVERY_OS_AUTO_QA still works (all → per-change, pr-only, off)', () => {
  assert.deepEqual(resolveQaSettings(undefined, 'all'), { style: 'per-change', prOnly: false });
  assert.deepEqual(resolveQaSettings(undefined, 'pr-only'), { style: 'rolling', prOnly: true });
  assert.deepEqual(resolveQaSettings(undefined, 'off'), { style: 'off', prOnly: false });
  assert.deepEqual(resolveQaSettings('per-change', 'pr-only'), { style: 'per-change', prOnly: true });
});

test('resolveQaSettings: a typo never turns the reminder off', () => {
  assert.equal(resolveQaSettings('rollling', undefined).style, 'rolling');
  assert.equal(resolveQaSettings(undefined, 'nope').style, 'rolling');
});

// ---------------------------------------------------------------------------
// Rolling issue body
// ---------------------------------------------------------------------------

const change = (n, extra = {}) =>
  buildChangeLine({ title: `Change ${n}`, ref: `sha${n}`, author: 'dev', linkedIssue: null, originMarker: `Direct push #sha${n}`, ...extra });

test('buildRollingQaBody has the QA fields, a Changes checklist and the Approved box, with its own footer', () => {
  const body = buildRollingQaBody(change(1));
  for (const heading of ['### Related Sprint Task Issue (#)', '### What Changed (plain English)', '### Changes', '### What to Test', '### QA Outcome', '### QA Approval']) {
    assert.ok(body.includes(heading), heading);
  }
  assert.match(body, /- \[ \] Change 1 \(sha1\) by @dev/);
  assert.ok(body.includes(`- [ ] ${APPROVAL_BOX}`));
  assert.ok(body.endsWith(ROLLING_FOOTER));
  assert.equal(approvalBoxTicked(body), false);
});

test('the rolling footer is never mistaken for a per-change filing by release auto-close', () => {
  const issue = { number: 1, body: buildRollingQaBody(change(1)), created_at: '2026-01-01T00:00:00Z' };
  assert.deepEqual(selectFilingsToCloseOnRelease([issue], '2026-12-01T00:00:00Z'), []);
});

test('buildChangeLine: PR ref, author, linked issue, and plain-English draft bullets (title not repeated)', () => {
  const line = buildChangeLine({
    title: 'Goodbye message', ref: '#6', author: 'dev2', linkedIssue: 3, originMarker: 'PR #6',
    summary: '- Goodbye message\n- Move goodbye message to its own file',
  });
  assert.equal(line.split('\n')[0], '- [ ] Goodbye message (#6) by @dev2 — for #3 <!-- delivery-os:origin=PR #6 -->');
  assert.deepEqual(line.split('\n').slice(1), ['  - Move goodbye message to its own file']);
});

test('appendChange adds each change to the checklist, in order, and parseChanges reads them back', () => {
  let body = buildRollingQaBody(change(1));
  body = appendChange(body, change(2));
  body = appendChange(body, change(3, { summary: '- Change 3\n- Could affect: search' }));
  const parsed = parseChanges(body);
  assert.deepEqual(parsed.map((c) => c.originMarker), ['Direct push #sha1', 'Direct push #sha2', 'Direct push #sha3']);
  assert.deepEqual(parsed[2].bullets, ['- Could affect: search']);
  assert.ok(body.indexOf('Change 3') < body.indexOf('### What to Test'), 'changes stay inside the Changes section');
});

test('hasChange detects a change already on the list (no duplicates)', () => {
  const body = buildRollingQaBody(change(1));
  assert.equal(hasChange(body, 'Direct push #sha1'), true);
  assert.equal(hasChange(body, 'Direct push #sha2'), false);
  assert.equal(hasChange(body, 'PR #1'), false);
});

test('approving ticks every change and the Approved box and sets QA Outcome Pass; declining clears the box and sets Fail', () => {
  const body = appendChange(buildRollingQaBody(change(1)), change(2));
  const approved = markRollingApproved(body);
  assert.ok(parseChanges(approved).every((c) => c.checked));
  assert.equal(approvalBoxTicked(approved), true);
  assert.match(approved, /### QA Outcome\n\nPass/);

  const declined = markRollingDeclined(approved);
  assert.equal(approvalBoxTicked(declined), false);
  assert.match(declined, /### QA Outcome\n\nFail/);
});

test('approvalBoxJustTicked only fires on the edit that ticks the box', () => {
  const body = buildRollingQaBody(change(1));
  const ticked = body.replace(`- [ ] ${APPROVAL_BOX}`, `- [x] ${APPROVAL_BOX}`);
  assert.equal(approvalBoxJustTicked(body, ticked), true);
  assert.equal(approvalBoxJustTicked(ticked, ticked), false); // already ticked
  assert.equal(approvalBoxJustTicked(undefined, ticked), false); // title-only edit
  assert.equal(approvalBoxJustTicked(body, appendChange(body, change(2))), false); // other edit
  assert.equal(approvalBoxTicked(untickApprovalBox(ticked)), false);
});

// ---------------------------------------------------------------------------
// Verdict vocabulary (shared matcher)
// ---------------------------------------------------------------------------

test('every approval phrase approves, case-insensitively, with anything after it', () => {
  for (const phrase of ROLLING_QA_APPROVE_PHRASES) {
    assert.equal(matchRollingQaVerdict(phrase), 'approved', phrase);
    assert.equal(matchRollingQaVerdict(`${phrase.toUpperCase()} — thanks!`), 'approved', `${phrase} (upper + suffix)`);
  }
});

test('every approval emoji approves (including skin tones)', () => {
  for (const emoji of [...ROLLING_QA_APPROVE_EMOJI, '👍🏽']) {
    assert.equal(matchRollingQaVerdict(`${emoji} tested on staging`), 'approved', emoji);
  }
});

test('every decline phrase and emoji declines', () => {
  for (const phrase of ROLLING_QA_DECLINE_PHRASES) {
    assert.equal(matchRollingQaVerdict(`${phrase}: login is broken`), 'declined', phrase);
  }
  for (const emoji of ROLLING_QA_DECLINE_EMOJI) {
    assert.equal(matchRollingQaVerdict(`${emoji} broken`), 'declined', emoji);
  }
});

test('"not approved" and "not ok" are declines, never approvals', () => {
  assert.equal(matchRollingQaVerdict('not approved'), 'declined');
  assert.equal(matchRollingQaVerdict('Not  approved yet'), 'declined');
  assert.equal(matchRollingQaVerdict('not ok'), 'declined');
});

test('phrases must start the comment and match whole words', () => {
  assert.equal(matchRollingQaVerdict('okay, will look later'), null);
  assert.equal(matchRollingQaVerdict('I think this is approved'), null);
  assert.equal(matchRollingQaVerdict('Testing now'), null);
  assert.equal(matchRollingQaVerdict('rejection handling looks odd'), null);
  assert.equal(matchRollingQaVerdict(''), null);
});

test('the release gate keeps its original vocabulary (only the matcher is shared)', () => {
  assert.equal(APPROVE_RE.test('lgtm'), false);
  assert.equal(APPROVE_RE.test('ship it'), false);
  assert.equal(DECLINE_RE.test('failed'), false);
  assert.equal(DECLINE_RE.test('needs work'), false);
  assert.equal(QA_APPROVE_RE.test('looks good to me'), true);
  assert.equal(APPROVE_RE.test('go  ahead'), true);
});

test('latest verdict wins: approve → close; later decline → reopen; later approve → close again', () => {
  let state = 'open';
  const apply = (verdict, anotherRollingOpen = false) => {
    const action = nextRollingQaAction({ state, verdict, anotherRollingOpen });
    if (action === 'close') state = 'closed';
    if (action === 'reopen-declined') state = 'open';
    return action;
  };
  assert.equal(apply('declined'), 'ack-decline');
  assert.equal(state, 'open');
  assert.equal(apply('approved'), 'close');
  assert.equal(apply('declined'), 'reopen-declined');
  assert.equal(state, 'open');
  assert.equal(apply('approved'), 'close');
  assert.equal(apply('approved'), 'already-closed');
  assert.equal(apply('declined', true), 'redirect'); // a newer rolling issue took over
});

// ---------------------------------------------------------------------------
// auto-qa-request.yml, rolling mode (real workflow script, fake GitHub)
// ---------------------------------------------------------------------------

const codePush = (sha, message, files = ['src/app.js']) => ({ [sha]: { files, messages: [message] } });

test('rolling: the first change opens the rolling issue; the next ones append to it (3 pushes → 1 issue, 3 lines)', async () => {
  const { github, store } = createFakeRepo({
    commits: { ...codePush('a1', 'Add wave'), ...codePush('a2', 'Add shout'), ...codePush('a3', 'Add whisper') },
  });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'Add wave') });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a2', 'Add shout') });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a3', 'Add whisper') });

  const open = openRolling(store);
  assert.equal(open.length, 1);
  assert.equal(open[0].title, ROLLING_TITLE);
  assert.deepEqual(parseChanges(open[0].body).map((c) => c.text), [
    'Add wave (a1) by @dev', 'Add shout (a2) by @dev', 'Add whisper (a3) by @dev',
  ]);
  assert.equal(store.issues.length, 1, 'no Task, no per-change QA Request');
});

test('rolling: the same push is never added twice', async () => {
  const { github, store } = createFakeRepo({ commits: codePush('a1', 'Add wave') });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'Add wave') });
  const { logs } = await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'Add wave') });
  assert.equal(parseChanges(openRolling(store)[0].body).length, 1);
  assert.ok(logs.some((l) => /already on rolling QA issue/.test(l)));
});

test('rolling: docs-only pushes and [skip qa-request] pushes add nothing', async () => {
  const { github, store } = createFakeRepo({
    commits: { ...codePush('d1', 'Update README', ['README.md', 'docs/a.md']), ...codePush('s1', 'Tweak [skip qa-request]') },
  });
  await runScript(FILE_SCRIPT, { github, context: pushContext('d1', 'Update README') });
  await runScript(FILE_SCRIPT, { github, context: pushContext('s1', 'Tweak [skip qa-request]') });
  assert.equal(store.issues.length, 0);
});

test('rolling: a linked issue is referenced on the line and no Task is filed', async () => {
  const { github, store } = createFakeRepo({
    issues: [{ number: 5, title: 'TASK - Greeting', labels: ['task'], body: '### Acceptance Criteria\n\n- works' }],
    commits: codePush('a1', 'Friendlier greeting\n\nRefs #5'),
  });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'Friendlier greeting\n\nRefs #5') });
  assert.match(openRolling(store)[0].body, /Friendlier greeting \(a1\) by @dev — for #5/);
  assert.equal(store.issues.filter((i) => i.labels.includes('task')).length, 1, 'only the pre-existing Task');
});

test('rolling: a PR adds its line when it merges (not when it opens), and its merge push is skipped', async () => {
  const pulls = { 7: { files: [{ filename: 'src/a.js' }], commits: ['Add export', 'Tidy export'], merged: true } };
  const { github, store } = createFakeRepo({
    pulls,
    commits: { m1: { files: ['src/a.js'], messages: ['Add export'], prs: [{ number: 7, merged_at: '2026-09-24T00:00:00Z' }] } },
  });
  await runScript(FILE_SCRIPT, { github, context: prContext(7, { title: 'Export button' }) });
  assert.equal(store.issues.length, 0, 'nothing at open');

  await runScript(FILE_SCRIPT, { github, context: prContext(7, { action: 'closed', merged: true, title: 'Export button', body: 'Closes #99' }) });
  const body = openRolling(store)[0].body;
  assert.match(body, /- \[ \] Export button \(#7\) by @dev <!-- delivery-os:origin=PR #7 -->/);
  assert.match(body, /\n {2}- Add export\n {2}- Tidy export/);

  // A rebase-merge push of the same PR carries no merge marker; it's matched by commit instead.
  await runScript(FILE_SCRIPT, { github, context: pushContext('m1', 'Add export') });
  assert.equal(parseChanges(openRolling(store)[0].body).length, 1);
});

test('rolling + pr-only: direct pushes add nothing, merged PRs still do', async () => {
  const pulls = { 8: { files: [{ filename: 'src/a.js' }], commits: ['Fix'], merged: true } };
  const { github, store } = createFakeRepo({ pulls, commits: codePush('a1', 'Direct fix') });
  const env = { DELIVERY_OS_AUTO_QA: 'pr-only' };
  await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'Direct fix'), env });
  assert.equal(store.issues.length, 0);
  await runScript(FILE_SCRIPT, { github, context: prContext(8, { action: 'closed', merged: true }), env });
  assert.equal(parseChanges(openRolling(store)[0].body).length, 1);
});

test('rolling: after approval closes the issue, the next change opens a fresh one', async () => {
  const { github, store } = createFakeRepo({ commits: { ...codePush('a1', 'One'), ...codePush('a2', 'Two') } });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'One') });
  const first = openRolling(store)[0];
  first.state = 'closed';
  first.state_reason = 'completed';
  await runScript(FILE_SCRIPT, { github, context: pushContext('a2', 'Two') });
  const open = openRolling(store);
  assert.equal(open.length, 1);
  assert.notEqual(open[0].number, first.number);
  assert.deepEqual(parseChanges(open[0].body).map((c) => c.originMarker), ['Direct push #a2']);
});

test('rolling: two rolling issues opened at once are folded into the oldest', async () => {
  const { github, store } = createFakeRepo({ commits: codePush('a2', 'Two') });
  // Simulate the race: another run opened one between our "none open" check and our create.
  const realCreate = github.rest.issues.create;
  let raced = false;
  github.rest.issues.create = async (args) => {
    if (!raced) {
      raced = true;
      await realCreate({ ...args, body: buildRollingQaBody(change(1)) });
    }
    return realCreate(args);
  };
  await runScript(FILE_SCRIPT, { github, context: pushContext('a2', 'Two') });
  const open = openRolling(store);
  assert.equal(open.length, 1);
  assert.deepEqual(parseChanges(open[0].body).map((c) => c.originMarker), ['Direct push #sha1', 'Direct push #a2']);
  assert.equal(store.issues.find((i) => i.number !== open[0].number).state_reason, 'not_planned');
});

// ---------------------------------------------------------------------------
// auto-qa-request.yml, per-change mode unchanged
// ---------------------------------------------------------------------------

test('per-change mode (DELIVERY_OS_AUTO_QA_MODE=per-change): a direct push still files a Task + QA Request', async () => {
  const { github, store } = createFakeRepo({ commits: codePush('a1', 'Add wave') });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'Add wave'), env: { DELIVERY_OS_AUTO_QA_MODE: 'per-change' } });
  assert.deepEqual(store.issues.map((i) => i.title).sort(), ['QA REQUEST - Add wave', 'TASK - Add wave']);
  assert.equal(openRolling(store).length, 0);
});

test('per-change via the 1.8.0 variable (DELIVERY_OS_AUTO_QA=all): a PR files at open, and nothing on merge', async () => {
  const pulls = { 9: { files: [{ filename: 'src/a.js' }], commits: ['Add export'], merged: true } };
  const { github, store } = createFakeRepo({ pulls });
  const env = { DELIVERY_OS_AUTO_QA: 'all' };
  await runScript(FILE_SCRIPT, { github, context: prContext(9, { title: 'Export' }), env });
  assert.deepEqual(store.issues.map((i) => i.title).sort(), ['QA REQUEST - Export', 'TASK - Export']);
  await runScript(FILE_SCRIPT, { github, context: prContext(9, { action: 'closed', merged: true, title: 'Export' }), env });
  assert.equal(store.issues.length, 2);
});

test('off mode files nothing', async () => {
  const { github, store } = createFakeRepo({ commits: codePush('a1', 'Add wave') });
  await runScript(FILE_SCRIPT, { github, context: pushContext('a1', 'Add wave'), env: { DELIVERY_OS_AUTO_QA_MODE: 'off' } });
  assert.equal(store.issues.length, 0);
});

// ---------------------------------------------------------------------------
// qa-rollup-approval.yml (real workflow script, fake GitHub)
// ---------------------------------------------------------------------------

function rollingRepo(extra = {}) {
  const body = appendChange(buildRollingQaBody(change(1)), change(2));
  return createFakeRepo({ issues: [{ number: 40, title: ROLLING_TITLE, labels: ROLLING, body }], ...extra });
}
const commentContext = (login, text, number = 40) => ({
  eventName: 'issue_comment',
  repo,
  payload: { issue: { number, labels: [{ name: 'qa-rollup' }] }, comment: { body: text, user: { login } } },
});
const editContext = (login, fromBody, toBody, number = 40) => ({
  eventName: 'issues',
  repo,
  payload: { action: 'edited', issue: { number, body: toBody, labels: [{ name: 'qa-rollup' }] }, changes: { body: { from: fromBody } }, sender: { login } },
});
const APPROVER_ENV = { QA_APPROVER: 'QaLead' };

test('approval: "lgtm" from the approver closes it as completed, ticks every line, and posts a summary', async () => {
  const { github, store } = rollingRepo();
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('qalead', 'LGTM, tested on staging'), env: APPROVER_ENV });
  const issue = store.issues[0];
  assert.equal(issue.state, 'closed');
  assert.equal(issue.state_reason, 'completed');
  assert.ok(parseChanges(issue.body).every((c) => c.checked));
  assert.equal(approvalBoxTicked(issue.body), true);
  assert.match(store.comments[0].body, /QA approved\*\* by @qalead[\s\S]*Covered 2 change\(s\)/);
});

test('approval: a ✅ comment from the approver closes it', async () => {
  const { github, store } = rollingRepo();
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('QaLead', '✅'), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'closed');
});

test('approval: the approver ticking the Approved box closes it', async () => {
  const { github, store } = rollingRepo();
  const before = store.issues[0].body;
  const after = before.replace(`- [ ] ${APPROVAL_BOX}`, `- [x] ${APPROVAL_BOX}`);
  store.issues[0].body = after;
  await runScript(APPROVAL_SCRIPT, { github, context: editContext('QaLead', before, after), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'closed');
  assert.match(store.comments[0].body, /ticked the Approved box/);
});

test('decline: "needs work" / ❌ from the approver keeps it open with an acknowledgement and QA Outcome Fail', async () => {
  for (const text of ['needs work: logout broke', '❌']) {
    const { github, store } = rollingRepo();
    await runScript(APPROVAL_SCRIPT, { github, context: commentContext('QaLead', text), env: APPROVER_ENV });
    assert.equal(store.issues[0].state, 'open', text);
    assert.match(store.issues[0].body, /### QA Outcome\n\nFail/);
    assert.match(store.comments[0].body, /QA declined\*\* by @QaLead/);
  }
});

test('non-approver: an approval comment is ignored with a short reply', async () => {
  const { github, store } = rollingRepo();
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('someone', 'approved'), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'open');
  assert.match(store.comments[0].body, /only the QA approver \(@QaLead\) can approve/);
});

test('non-approver: ticking the box is reverted with a short reply', async () => {
  const { github, store } = rollingRepo();
  const before = store.issues[0].body;
  const after = before.replace(`- [ ] ${APPROVAL_BOX}`, `- [x] ${APPROVAL_BOX}`);
  store.issues[0].body = after;
  await runScript(APPROVAL_SCRIPT, { github, context: editContext('someone', before, after), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'open');
  assert.equal(approvalBoxTicked(store.issues[0].body), false);
  assert.match(store.comments[0].body, /only the QA approver/);
});

test('ordinary discussion (no verdict phrase) does nothing, from anyone', async () => {
  const { github, store } = rollingRepo();
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('QaLead', 'Testing the export now'), env: APPROVER_ENV });
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('someone', 'any update?'), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'open');
  assert.equal(store.comments.length, 0);
});

test('latest verdict wins end to end: approve, then decline reopens it, then approve closes it again', async () => {
  const { github, store } = rollingRepo();
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('QaLead', 'approved'), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'closed');
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('QaLead', 'not approved — found a bug'), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'open');
  assert.match(store.comments[1].body, /Reopened/);
  await runScript(APPROVAL_SCRIPT, { github, context: commentContext('QaLead', 'ship it'), env: APPROVER_ENV });
  assert.equal(store.issues[0].state, 'closed');
});
