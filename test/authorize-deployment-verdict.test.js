'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const { computeVerdict, nextReleaseAction, parseLogins, selectFilingsToCloseOnRelease, parseFilingPrNumber } = require('../.github/scripts/authorize-deployment-verdict');
const { buildAutoTaskBody, buildQaRequestBody } = require('../.github/scripts/auto-qa-request');

const RELEASE = 'alice';
const QA = 'bob';

function comment(login, body) {
  return { user: { login }, body };
}

test('no comments -> no verdict, QA not approved', () => {
  const result = computeVerdict([], RELEASE, QA);
  assert.equal(result.releaseVerdict, null);
  assert.equal(result.qaApproved, false);
});

test('comments from unrelated users are ignored', () => {
  const result = computeVerdict(
    [comment('someone-else', 'approved'), comment('another-user', 'qa approved')],
    RELEASE,
    QA
  );
  assert.equal(result.releaseVerdict, null);
  assert.equal(result.qaApproved, false);
});

test('basic approve + QA approve keywords', () => {
  const result = computeVerdict([comment(RELEASE, 'approved'), comment(QA, 'qa ok')], RELEASE, QA);
  assert.equal(result.releaseVerdict, 'approved');
  assert.equal(result.qaApproved, true);
});

test('natural sentence starting with a keyword still matches', () => {
  const result = computeVerdict(
    [comment(RELEASE, 'Approved - looks solid, go ahead and ship'), comment(QA, 'looks good to me, QA passed everything')],
    RELEASE,
    QA
  );
  assert.equal(result.releaseVerdict, 'approved');
  assert.equal(result.qaApproved, true);
});

test('decline is superseded by a later approval from the same approver', () => {
  const result = computeVerdict(
    [
      comment(RELEASE, 'Declined - needs more tests'),
      comment(QA, 'QA OK'),
      comment(RELEASE, 'Approved, ship it'),
    ],
    RELEASE,
    QA
  );
  assert.equal(result.releaseVerdict, 'approved', 'a later approval must override an earlier decline');
  assert.equal(result.qaApproved, true);
});

test('approval is superseded by a later decline from the same approver', () => {
  const result = computeVerdict(
    [comment(RELEASE, 'approved'), comment(RELEASE, 'declined - found an issue')],
    RELEASE,
    QA
  );
  assert.equal(result.releaseVerdict, 'declined');
});

test('"Rejected" (past tense) still declines — regression guard', () => {
  // The word-boundary anchoring added to stop substring false-positives once
  // broke this: "reject\b" doesn't match "Rejected" (the boundary check fails
  // between "t" and "e"). Caught by an external review; guard it permanently.
  const result = computeVerdict([comment(RELEASE, 'Rejected due to a bug')], RELEASE, QA);
  assert.equal(result.releaseVerdict, 'declined');
});

test('"not approved" leading the comment still declines', () => {
  const result = computeVerdict([comment(RELEASE, 'not approved, needs another pass')], RELEASE, QA);
  assert.equal(result.releaseVerdict, 'declined');
});

test('decline keyword mid-sentence does not false-trigger', () => {
  const result = computeVerdict(
    [comment(RELEASE, 'Nothing here has been rejected by legal, all clear')],
    RELEASE,
    QA
  );
  assert.equal(result.releaseVerdict, null);
});

test('"rejection" as a noun does not false-trigger', () => {
  const result = computeVerdict([comment(RELEASE, 'Rejection is not what I meant, still reviewing')], RELEASE, QA);
  assert.equal(result.releaseVerdict, null);
});

test('"okay" does not false-trigger as an approval', () => {
  const result = computeVerdict([comment(RELEASE, "okay, I'll look at this tomorrow")], RELEASE, QA);
  assert.equal(result.releaseVerdict, null);
});

test('a hedged reply starting with the keyword does not approve past the hedge', () => {
  // This is the false-positive the anchoring was built to fix in the first
  // place: previously "ok" matched anywhere as a bare prefix and this read as
  // an approval even though the approver was clearly not approving.
  const result = computeVerdict([comment(RELEASE, 'ok, hold off, I have concerns')], RELEASE, QA);
  // "ok" is followed by "," which is a word boundary, so this DOES match the
  // approve keyword under the current rule (boundary, not "whole comment").
  // Documented here as the accepted trade-off: keywords must lead the
  // comment, but anything after the keyword is not inspected.
  assert.equal(result.releaseVerdict, 'approved');
});

test('QA approval keyword mid-sentence does not false-trigger', () => {
  const result = computeVerdict(
    [comment(QA, "This looks good but I haven't tested it fully")],
    RELEASE,
    QA
  );
  assert.equal(result.qaApproved, false);
});

test('login comparison is case-insensitive', () => {
  const result = computeVerdict([comment('Alice', 'approved'), comment('BOB', 'qa ok')], RELEASE, QA);
  assert.equal(result.releaseVerdict, 'approved');
  assert.equal(result.qaApproved, true);
});

test('QA approving does not count as a release verdict, and vice versa', () => {
  const result = computeVerdict([comment(QA, 'approved')], RELEASE, QA);
  assert.equal(result.releaseVerdict, null, 'QA is not the release approver');
  assert.equal(result.qaApproved, true, 'but "approved" is a valid QA keyword too');
});

// selectFilingsToCloseOnRelease

const RELEASE_REQUESTED_AT = '2026-09-20T12:00:00Z';
const BEFORE = '2026-09-19T12:00:00Z';
const AFTER = '2026-09-21T12:00:00Z';

const autoTaskBody = buildAutoTaskBody({ number: null, title: 't', url: '', author: null, viaDirectPush: true });
const autoQaBody = buildQaRequestBody({
  relatedIssueNumber: 1, prNumber: null, prTitle: 't', prUrl: '', branch: 'main',
  filesChanged: [], acceptanceCriteria: null, originMarker: 'Direct push #abc',
});

test('selectFilingsToCloseOnRelease picks auto-qa-request Tasks and QA Requests filed before the release', () => {
  const issues = [
    { number: 1, body: autoTaskBody, created_at: BEFORE },
    { number: 2, body: autoQaBody, created_at: BEFORE },
  ];
  assert.deepEqual(selectFilingsToCloseOnRelease(issues, RELEASE_REQUESTED_AT), [1, 2]);
});

test('selectFilingsToCloseOnRelease skips anything filed after the release was requested', () => {
  const issues = [{ number: 1, body: autoQaBody, created_at: AFTER }];
  assert.deepEqual(selectFilingsToCloseOnRelease(issues, RELEASE_REQUESTED_AT), []);
});

test('selectFilingsToCloseOnRelease never touches issues without an auto-qa-request footer', () => {
  const issues = [
    { number: 1, body: '### Task Summary\n\nReal work the skill is tracking', created_at: BEFORE },
    { number: 2, body: '', created_at: BEFORE },
    { number: 3, body: autoQaBody, created_at: BEFORE, pull_request: {} },
  ];
  assert.deepEqual(selectFilingsToCloseOnRelease(issues, RELEASE_REQUESTED_AT), []);
});

// parseFilingPrNumber

test('parseFilingPrNumber reads the PR from an auto-filed QA Request or Task', () => {
  const prQa = buildQaRequestBody({
    relatedIssueNumber: 1, prNumber: 12, prTitle: 't', prUrl: '', branch: 'b',
    filesChanged: [], acceptanceCriteria: null, originMarker: 'PR #12',
  });
  const prTask = buildAutoTaskBody({ number: 12, title: 't', url: 'https://x/pull/12', author: 'a', viaDirectPush: false });
  assert.equal(parseFilingPrNumber(prQa), 12);
  assert.equal(parseFilingPrNumber(prTask), 12);
});

test('parseFilingPrNumber returns null for direct-push filings', () => {
  assert.equal(parseFilingPrNumber(autoQaBody), null);
  assert.equal(parseFilingPrNumber(autoTaskBody), null);
  assert.equal(parseFilingPrNumber(''), null);
});

test('approver variables accept comma-separated lists (trimmed, case-insensitive)', () => {
  assert.deepEqual(parseLogins(' UserA, @userB ,,'), ['usera', 'userb']);
  const r = computeVerdict(
    [comment('USERB', 'approved'), comment('carol', 'qa ok')],
    'userA, userB',
    'bob,carol'
  );
  assert.equal(r.releaseVerdict, 'approved');
  assert.equal(r.qaApproved, true);
});

test('any release approver in the list can decline; non-listed users are ignored', () => {
  const r = computeVerdict(
    [comment('userA', 'approved'), comment('userB', 'declined'), comment('mallory', 'approved')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'declined');
});

test('per-approver: A declines, B approves -> declined', () => {
  const r = computeVerdict(
    [comment('userA', 'declined'), comment('userB', 'approved')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'declined', "B's approval must not lift A's decline");
});

test('per-approver: B approves, A declines later -> declined', () => {
  const r = computeVerdict(
    [comment('userB', 'approved'), comment('userA', 'declined')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'declined');
});

test('per-approver: A declines, then A approves -> approved', () => {
  const r = computeVerdict(
    [comment('userA', 'declined'), comment('userA', 'approved')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'approved');
});

test('per-approver: A declines, B approves, A re-approves -> approved', () => {
  const r = computeVerdict(
    [comment('userA', 'declined'), comment('userB', 'approved'), comment('userA', 'approved')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'approved');
});

test('per-approver: logins are matched case-insensitively when tracking each approver', () => {
  const r = computeVerdict(
    [comment('USERA', 'declined'), comment('usera', 'approved'), comment('userB', 'approved')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'approved', 'USERA and usera are the same approver');
  const blocked = computeVerdict(
    [comment('USERA', 'declined'), comment('userB', 'approved')],
    'usera,userb',
    QA
  );
  assert.equal(blocked.releaseVerdict, 'declined');
});

test('per-approver: a non-verdict comment from the decliner does not lift their decline', () => {
  const r = computeVerdict(
    [comment('userA', 'declined'), comment('userB', 'approved'), comment('userA', 'still looking into it')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'declined');
});

test('per-approver: two approvers who both approve -> approved; a second decliner needs to re-approve too', () => {
  assert.equal(
    computeVerdict([comment('userA', 'approved'), comment('userB', 'approved')], 'userA,userB', QA).releaseVerdict,
    'approved'
  );
  const r = computeVerdict(
    [comment('userA', 'declined'), comment('userB', 'declined'), comment('userA', 'approved')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'declined', "B's decline still stands");
});

test('per-approver: a decline blocks the release but does not affect QA sign-off', () => {
  const r = computeVerdict(
    [comment('userA', 'declined'), comment('userB', 'approved'), comment(QA, 'qa ok')],
    'userA,userB',
    QA
  );
  assert.equal(r.releaseVerdict, 'declined');
  assert.equal(r.qaApproved, true);
});

test('single release approver still works as before (latest verdict wins)', () => {
  assert.equal(
    computeVerdict([comment(RELEASE, 'declined'), comment(RELEASE, 'approved')], RELEASE, QA).releaseVerdict,
    'approved'
  );
  assert.equal(
    computeVerdict([comment(RELEASE, 'approved'), comment(RELEASE, 'declined')], RELEASE, QA).releaseVerdict,
    'declined'
  );
});

test('nextReleaseAction: decline once (from either side), then nothing until the verdict changes', () => {
  assert.equal(nextReleaseAction({ releaseVerdict: 'declined', qaVerdict: 'approved', declined: false, ready: true }), 'decline');
  assert.equal(nextReleaseAction({ releaseVerdict: 'approved', qaVerdict: 'declined', declined: false, ready: true }), 'decline');
  assert.equal(nextReleaseAction({ releaseVerdict: 'declined', qaVerdict: null, declined: true, ready: false }), 'none');
});

test('nextReleaseAction: authorize needs the release verdict AND QA, and only once', () => {
  assert.equal(nextReleaseAction({ releaseVerdict: 'approved', qaVerdict: 'approved', declined: false, ready: false }), 'authorize');
  assert.equal(nextReleaseAction({ releaseVerdict: 'approved', qaVerdict: 'approved', declined: true, ready: false }), 'authorize', 'a re-approval after a decline authorizes and clears the label');
  assert.equal(nextReleaseAction({ releaseVerdict: 'approved', qaVerdict: 'approved', declined: false, ready: true }), 'none');
  assert.equal(nextReleaseAction({ releaseVerdict: 'approved', qaVerdict: null, declined: false, ready: false }), 'none');
  assert.equal(nextReleaseAction({ releaseVerdict: null, qaVerdict: 'approved', declined: false, ready: false }), 'none');
});

test('nextReleaseAction: a lifted decline clears the stale `declined` label even before sign-off is complete', () => {
  assert.equal(nextReleaseAction({ releaseVerdict: 'approved', qaVerdict: null, declined: true, ready: false }), 'clear-declined');
  assert.equal(nextReleaseAction({ releaseVerdict: null, qaVerdict: 'approved', declined: true, ready: false }), 'clear-declined');
  assert.equal(nextReleaseAction({ releaseVerdict: 'approved', qaVerdict: 'approved', declined: true, ready: true }), 'clear-declined');
});

test('nextReleaseAction: no verdict from anyone means nothing to do', () => {
  assert.equal(nextReleaseAction({ releaseVerdict: null, qaVerdict: null, declined: true, ready: true }), 'none');
});

// --- QA approvers on the release gate: per-approver, and they can decline ---

test('QA: a QA approver can decline the release gate, and a decline is not overridden by another QA approver', () => {
  const qa = 'qa1,qa2';
  assert.equal(computeVerdict([comment('qa1', 'qa declined - crash on login')], RELEASE, qa).qaVerdict, 'declined');
  assert.equal(computeVerdict([comment('qa1', 'not approved')], RELEASE, qa).qaVerdict, 'declined');
  assert.equal(computeVerdict([comment('qa1', 'declined'), comment('qa2', 'qa ok')], RELEASE, qa).qaVerdict, 'declined');
  assert.equal(computeVerdict([comment('qa2', 'qa ok'), comment('qa1', 'declined')], RELEASE, qa).qaVerdict, 'declined');
  assert.equal(computeVerdict([comment('qa1', 'declined'), comment('qa2', 'qa ok')], RELEASE, qa).qaApproved, false);
});

test('QA: the approver who declined lifts it by approving', () => {
  const qa = 'qa1,qa2';
  const r = computeVerdict([comment('qa1', 'declined'), comment('qa2', 'qa ok'), comment('qa1', 'qa approved')], RELEASE, qa);
  assert.equal(r.qaVerdict, 'approved');
  assert.equal(r.qaApproved, true);
});

test('QA: a single QA approver can withdraw an earlier approval by declining', () => {
  const r = computeVerdict([comment(QA, 'qa ok'), comment(QA, 'not approved, regression found')], RELEASE, QA);
  assert.equal(r.qaVerdict, 'declined');
  assert.equal(r.qaApproved, false);
});

test('QA: release and QA sides are independent', () => {
  const r = computeVerdict([comment(RELEASE, 'declined'), comment(QA, 'qa ok')], RELEASE, QA);
  assert.equal(r.releaseVerdict, 'declined');
  assert.equal(r.qaVerdict, 'approved');
  const s2 = computeVerdict([comment(RELEASE, 'approved'), comment(QA, 'qa declined')], RELEASE, QA);
  assert.equal(s2.releaseVerdict, 'approved');
  assert.equal(s2.qaVerdict, 'declined');
});

// --- rolling QA: per-approver decline -----------------------------------

const { nextRollingQaAction, rollingQaVerdictLog, otherQaDecliners } = require('../.github/scripts/authorize-deployment-verdict');
const bot = (body) => ({ user: { login: 'github-actions[bot]' }, body });

test('nextRollingQaAction: an approval is refused while another approver\'s decline stands', () => {
  assert.equal(nextRollingQaAction({ state: 'open', verdict: 'approved', anotherRollingOpen: false, blockedBy: ['qa1'] }), 'blocked');
  assert.equal(nextRollingQaAction({ state: 'open', verdict: 'approved', anotherRollingOpen: false, blockedBy: [] }), 'close');
  assert.equal(nextRollingQaAction({ state: 'closed', verdict: 'approved', anotherRollingOpen: false, blockedBy: ['qa1'] }), 'already-closed');
  assert.equal(nextRollingQaAction({ state: 'open', verdict: 'declined', anotherRollingOpen: false, blockedBy: ['qa1'] }), 'ack-decline');
});

test('rollingQaVerdictLog reads each approver\'s latest verdict from the workflow\'s own announcements', () => {
  const log = rollingQaVerdictLog([
    bot('🔴 **QA declined** by @QA1 (commented "needs work").\n\nThis stays open'),
    bot('✅ **QA approved** by @qa2 (ticked the Approved box).'),
    bot('🔴 **QA declined** by @qa2 (commented "❌").'),
    bot('✅ **QA approved** by @qa1 (commented "approved").'),
  ]);
  assert.deepEqual([...log], [['qa1', 'approved'], ['qa2', 'declined']]);
});

test('rollingQaVerdictLog ignores anything a person typed, even if it looks like an announcement', () => {
  const log = rollingQaVerdictLog([
    { user: { login: 'mallory' }, body: '🔴 **QA declined** by @qa1 (commented "x").' },
    { user: { login: 'qa1' }, body: 'declined' },
    bot('@someone thanks — only the QA approver (@qa1) can approve this, so I\'ve left it as it is.'),
  ]);
  assert.equal(log.size, 0);
});

test('otherQaDecliners excludes the actor themselves', () => {
  const log = new Map([['qa1', 'declined'], ['qa2', 'declined'], ['qa3', 'approved']]);
  assert.deepEqual(otherQaDecliners(log, 'QA1'), ['qa2']);
  assert.deepEqual(otherQaDecliners(log, 'qa3'), ['qa1', 'qa2']);
  assert.deepEqual(otherQaDecliners(new Map(), 'qa1'), []);
});

// --- 1.12.2 review findings ---

test('same login in both lists: the release words lift their own QA decline', () => {
  for (const word of ['ok', 'go ahead', 'approve', 'approved']) {
    const r = computeVerdict([comment('solo', 'declined'), comment('solo', word)], 'solo', 'solo');
    assert.equal(r.releaseVerdict, 'approved', word);
    assert.equal(r.qaVerdict, 'approved', word);
  }
});

test('QA-only logins keep the QA vocabulary: "ok" does not approve QA', () => {
  const r = computeVerdict([comment('qa1', 'ok')], 'rel1', 'qa1');
  assert.equal(r.qaVerdict, null);
});

test('rollingQaVerdictLog keeps logins with underscores whole (Enterprise Managed Users)', () => {
  const log = rollingQaVerdictLog([bot('🔴 **QA declined** by @alice_corp (commented "x").')]);
  assert.deepEqual([...log], [['alice_corp', 'declined']]);
  assert.deepEqual(otherQaDecliners(log, 'alice_corp'), []);
  assert.deepEqual(otherQaDecliners(log, 'bob'), ['alice_corp']);
});

test('otherQaDecliners ignores decliners who are no longer QA approvers', () => {
  const log = new Map([['gone', 'declined'], ['qa2', 'declined']]);
  assert.deepEqual(otherQaDecliners(log, 'qa1', ['QA1', 'qa2']), ['qa2']);
  assert.deepEqual(otherQaDecliners(log, 'qa1', ['qa1']), []);
});
