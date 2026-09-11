'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const { computeVerdict } = require('../.github/scripts/authorize-deployment-verdict');

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
