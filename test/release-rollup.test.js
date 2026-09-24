'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const {
  ROLLUP_MARKER,
  REVIEW_BOX,
  findPreviousAuthorizedRelease,
  selectQaRequestsInWindow,
  selectRollingIssues,
  parseOriginPrNumber,
  extractWhatChanged,
  isReviewed,
  extractQaOutcome,
  buildRollupComment,
} = require('../.github/scripts/release-rollup');
const { buildQaRequestBody, CHANGELOG_REVIEW_BOX, buildRollingQaBody, buildChangeLine, appendChange, markRollingApproved, markRollingDeclined } = require('../.github/scripts/auto-qa-request');

const qaBody = (overrides = {}) =>
  buildQaRequestBody({
    relatedIssueNumber: 1,
    prNumber: null,
    prTitle: 'Tweak',
    prUrl: '',
    branch: 'main',
    filesChanged: [],
    acceptanceCriteria: null,
    originMarker: 'Direct push #abc',
    ...overrides,
  });

const reviewedBody = (whatChanged) =>
  [
    '### Related Sprint Task Issue (#)',
    '',
    '#1',
    '',
    '### What Changed (plain English)',
    '',
    whatChanged,
    '',
    '### Changelog Review',
    '',
    `- [x] ${REVIEW_BOX}`,
    '',
    '### QA Outcome',
    '',
    'Pass',
  ].join('\n');

// Drift guards against auto-qa-request.js / qa_request.yml

test('REVIEW_BOX matches the checkbox auto-qa-request writes', () => {
  assert.equal(REVIEW_BOX, CHANGELOG_REVIEW_BOX);
});

test('extractWhatChanged recognizes an auto-filed draft', () => {
  const wc = extractWhatChanged(qaBody({ changeSummary: '- Speed up search' }));
  assert.deepEqual(wc, { bullets: ['- Speed up search'], couldAffect: [], isDraft: true, missing: false });
  assert.equal(isReviewed(qaBody()), false);
});

// findPreviousAuthorizedRelease

test('findPreviousAuthorizedRelease picks the latest earlier release labeled ready-for-deploy', () => {
  const issues = [
    { number: 10, created_at: '2026-09-01T00:00:00Z', labels: [{ name: 'production' }, { name: 'ready-for-deploy' }] },
    { number: 20, created_at: '2026-09-10T00:00:00Z', labels: ['production', 'ready-for-deploy'] },
    { number: 25, created_at: '2026-09-12T00:00:00Z', labels: [{ name: 'production' }, { name: 'declined' }] },
    { number: 30, created_at: '2026-09-20T00:00:00Z', labels: [{ name: 'production' }] },
  ];
  assert.equal(findPreviousAuthorizedRelease(issues, issues[3]).number, 20);
});

test('findPreviousAuthorizedRelease returns null for the first release', () => {
  const release = { number: 30, created_at: '2026-09-20T00:00:00Z', labels: [] };
  assert.equal(findPreviousAuthorizedRelease([release], release), null);
});

// selectQaRequestsInWindow

test('selectQaRequestsInWindow keeps requests inside the window plus older ones still open, oldest first', () => {
  const issues = [
    { number: 5, created_at: '2026-09-05T00:00:00Z', state: 'open' },
    { number: 6, created_at: '2026-09-06T00:00:00Z', state: 'closed', state_reason: 'completed' },
    { number: 3, created_at: '2026-09-11T00:00:00Z', state: 'closed', state_reason: 'completed' },
    { number: 7, created_at: '2026-09-15T00:00:00Z', state: 'open' },
    { number: 8, created_at: '2026-09-25T00:00:00Z', state: 'open' },
    { number: 9, created_at: '2026-09-12T00:00:00Z', state: 'closed', state_reason: 'not_planned' },
    { number: 4, created_at: '2026-09-13T00:00:00Z', pull_request: {} },
  ];
  const picked = selectQaRequestsInWindow(issues, '2026-09-10T00:00:00Z', '2026-09-20T00:00:00Z');
  // #5 predates the window but is still open, so it hasn't shipped yet;
  // #6 predates it and is closed, so an earlier release covered it.
  assert.deepEqual(picked.map((i) => i.number), [3, 5, 7]);
});

test('selectQaRequestsInWindow: a QA Request filed before release N whose PR merged after it lands in release N+1', () => {
  // Regression (code review): keyed only on created_at, #30 fell into no roll-up at all.
  const qa30 = { number: 30, created_at: '2026-09-01T00:00:00Z', state: 'open' };
  const release31 = '2026-09-02T00:00:00Z';
  const release35 = '2026-09-10T00:00:00Z';
  assert.deepEqual(selectQaRequestsInWindow([qa30], release31, release35).map((i) => i.number), [30]);
});

test('selectQaRequestsInWindow with no previous release takes everything up to the release', () => {
  const issues = [
    { number: 1, created_at: '2025-01-01T00:00:00Z' },
    { number: 2, created_at: '2026-09-25T00:00:00Z' },
  ];
  assert.deepEqual(selectQaRequestsInWindow(issues, null, '2026-09-20T00:00:00Z').map((i) => i.number), [1]);
});

// parseOriginPrNumber

test('parseOriginPrNumber reads the PR a QA Request was auto-filed for', () => {
  assert.equal(parseOriginPrNumber(qaBody({ prNumber: 12, originMarker: 'PR #12' })), 12);
  assert.equal(parseOriginPrNumber(qaBody()), null);
  assert.equal(parseOriginPrNumber('hand-filed, no footer'), null);
});

// extractWhatChanged

test('extractWhatChanged separates bullets from Could affect areas', () => {
  const wc = extractWhatChanged(
    reviewedBody('- The login page remembers your email\n- Search is faster\nCould affect: signing out, search filters.')
  );
  assert.deepEqual(wc.bullets, ['- The login page remembers your email', '- Search is faster']);
  assert.deepEqual(wc.couldAffect, ['signing out', 'search filters']);
  assert.equal(wc.isDraft, false);
});

test('extractWhatChanged turns plain lines into bullets and accepts a bulleted Could affect line', () => {
  const wc = extractWhatChanged(reviewedBody('Search is faster\n* Export works offline\n- Could affect: exports'));
  assert.deepEqual(wc.bullets, ['- Search is faster', '- Export works offline']);
  assert.deepEqual(wc.couldAffect, ['exports']);
});

test('extractWhatChanged reports a missing section (pre-changelog QA Requests, empty form field)', () => {
  assert.equal(extractWhatChanged('### What to Test\n\nstuff').missing, true);
  assert.equal(extractWhatChanged('### What Changed (plain English)\n\n_No response_\n\n### What to Test').missing, true);
});

// isReviewed / extractQaOutcome

test('isReviewed needs the review box ticked', () => {
  assert.equal(isReviewed(reviewedBody('- x')), true);
  assert.equal(isReviewed(reviewedBody('- x').replace('[x]', '[ ]')), false);
});

test('extractQaOutcome reads the QA Outcome field, defaulting to Pending', () => {
  assert.equal(extractQaOutcome(reviewedBody('- x')), 'Pass');
  assert.equal(extractQaOutcome(qaBody()), 'Pending');
  assert.equal(extractQaOutcome('no such field'), 'Pending');
});

// buildRollupComment

test('buildRollupComment lists each QA Request with its status and merges Could affect areas', () => {
  const comment = buildRollupComment({
    qaRequests: [
      { number: 41, title: 'QA REQUEST - Login tweaks', state: 'closed', body: reviewedBody('- The login page remembers your email\nCould affect: signing out') },
      { number: 45, title: 'QA REQUEST - Speed up search', state: 'open', body: qaBody({ changeSummary: '- Speed up search' }) },
      { number: 46, title: 'QA REQUEST - Old thing', state: 'open', body: '### What to Test\n\nstuff' },
    ],
    unmerged: [{ number: 47, prNumber: 12 }],
    previousRelease: { number: 20, created_at: '2026-09-10T00:00:00Z' },
  });

  assert.ok(comment.startsWith(ROLLUP_MARKER));
  assert.match(comment, /since the last authorized release \(#20, opened 2026-09-10\), plus older ones still open/);
  assert.match(comment, /doesn't block approval/);
  assert.match(comment, /### ✅ #41 Login tweaks\n_QA: Pass · closed_\n\n- The login page remembers your email/);
  assert.match(comment, /### ⚠️ #45 Speed up search: not reviewed by dev \(still the auto-generated draft\)/);
  assert.match(comment, /### ⚠️ #46 Old thing: no What Changed notes/);
  assert.match(comment, /\*\*Could affect:\*\* signing out/);
  assert.match(comment, /\*\*1 of 3 changelogs dev-reviewed\.\*\* Not yet reviewed: #45, #46/);
  assert.match(comment, /Not included, PR not merged yet: #47 \(PR #12\)/);
});

test('buildRollupComment says so when everything is reviewed', () => {
  const comment = buildRollupComment({
    qaRequests: [{ number: 41, title: 'QA REQUEST - Login', state: 'open', body: reviewedBody('- x') }],
    unmerged: [],
    previousRelease: null,
  });
  assert.match(comment, /no earlier authorized release found/);
  assert.match(comment, /\*\*All 1 changelogs dev-reviewed\.\*\*/);
  assert.doesNotMatch(comment, /Not included/);
});

test('buildRollupComment handles an empty window', () => {
  const comment = buildRollupComment({ qaRequests: [], unmerged: [], previousRelease: null });
  assert.match(comment, /No QA Requests found in that window/);
  assert.doesNotMatch(comment, /dev-reviewed/);
});

test('buildRollupComment caps the list and names the rest', () => {
  const qaRequests = Array.from({ length: 33 }, (_, i) => ({
    number: i + 1, title: `QA REQUEST - Item ${i + 1}`, state: 'open', body: reviewedBody('- x'),
  }));
  const comment = buildRollupComment({ qaRequests, unmerged: [], previousRelease: null });
  assert.match(comment, /…and 3 more: #31, #32, #33/);
  assert.match(comment, /\*\*All 30 changelogs dev-reviewed\.\*\*/);
});

// Rolling QA issue in the roll-up

const rollingLabels = [{ name: 'qa-request' }, { name: 'delivery-ops-filed' }, { name: 'qa-rollup' }];
const rollingBody = () =>
  appendChange(
    buildRollingQaBody(buildChangeLine({ title: 'Add wave', ref: 'a1', author: 'dev', linkedIssue: 1, originMarker: 'Direct push #a1', summary: '- Add wave\n- Waves hello\n- Could affect: greeting' })),
    buildChangeLine({ title: 'Export button', ref: '#7', author: 'dev2', linkedIssue: null, originMarker: 'PR #7' })
  );

test('selectRollingIssues: the open rolling issue plus ones approved since the last release', () => {
  const issues = [
    { number: 1, state: 'closed', state_reason: 'completed', created_at: '2026-09-01T00:00:00Z', closed_at: '2026-09-05T00:00:00Z', labels: rollingLabels },
    { number: 2, state: 'closed', state_reason: 'completed', created_at: '2026-09-06T00:00:00Z', closed_at: '2026-09-12T00:00:00Z', labels: rollingLabels },
    { number: 3, state: 'closed', state_reason: 'not_planned', created_at: '2026-09-13T00:00:00Z', closed_at: '2026-09-13T00:00:00Z', labels: rollingLabels },
    { number: 4, state: 'open', created_at: '2026-09-14T00:00:00Z', labels: rollingLabels },
    { number: 5, state: 'open', created_at: '2026-09-14T00:00:00Z', labels: [{ name: 'qa-request' }] },
  ];
  assert.deepEqual(selectRollingIssues(issues, '2026-09-10T00:00:00Z', '2026-09-20T00:00:00Z').map((i) => i.number), [2, 4]);
});

test('selectQaRequestsInWindow leaves rolling issues to selectRollingIssues', () => {
  const issues = [{ number: 4, state: 'open', created_at: '2026-09-14T00:00:00Z', labels: rollingLabels }];
  assert.deepEqual(selectQaRequestsInWindow(issues, null, '2026-09-20T00:00:00Z'), []);
});

test('buildRollupComment lists each rolling change with its QA status and merges Could affect areas', () => {
  const comment = buildRollupComment({
    qaRequests: [],
    unmerged: [],
    previousRelease: null,
    rolling: [
      { number: 50, state: 'closed', state_reason: 'completed', body: markRollingApproved(rollingBody()) },
      { number: 60, state: 'open', body: rollingBody() },
      { number: 70, state: 'open', body: markRollingDeclined(rollingBody()) },
    ],
  });
  assert.match(comment, /### 🔄 Rolling QA #50: ✅ QA approved\n\n- ✅ Add wave \(a1\) by @dev — for #1\n {2}- Waves hello\n- ✅ Export button \(#7\) by @dev2/);
  assert.match(comment, /### 🔄 Rolling QA #60: ⚠️ awaiting QA approval\n\n- ⏳ Add wave/);
  assert.match(comment, /### 🔄 Rolling QA #70: ❌ QA declined, fixes awaiting re-test/);
  assert.match(comment, /\*\*Could affect:\*\* greeting/);
  assert.doesNotMatch(comment, /- Could affect/);
  assert.match(comment, /\*\*Rolling QA:\*\* 2 of 6 change\(s\) QA-approved\./);
  assert.doesNotMatch(comment, /No QA Requests found/);
});
