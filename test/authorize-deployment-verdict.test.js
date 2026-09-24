'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const { computeVerdict, selectFilingsToCloseOnRelease, parseFilingPrNumber } = require('../.github/scripts/authorize-deployment-verdict');
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
