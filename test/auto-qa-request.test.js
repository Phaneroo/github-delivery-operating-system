'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const {
  extractLinkedIssueNumbers,
  extractAcceptanceCriteria,
  parseMergedPrNumber,
  buildAutoTaskBody,
  buildQaRequestBody,
  qaRequestAlreadyExists,
} = require('../.github/scripts/auto-qa-request');

// extractLinkedIssueNumbers

test('extractLinkedIssueNumbers finds GitHub closing keywords', () => {
  assert.deepEqual(extractLinkedIssueNumbers('Closes #12'), [12]);
  assert.deepEqual(extractLinkedIssueNumbers('This fixes #7 and also resolves #8'), [7, 8]);
});

test('extractLinkedIssueNumbers is case-insensitive and matches every keyword form', () => {
  for (const kw of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']) {
    assert.deepEqual(extractLinkedIssueNumbers(`${kw.toUpperCase()} #5`), [5], `expected "${kw}" to match`);
  }
});

test('extractLinkedIssueNumbers dedupes repeated references', () => {
  assert.deepEqual(extractLinkedIssueNumbers('Closes #12\n\nAlso closes #12 again'), [12]);
});

test('extractLinkedIssueNumbers returns [] when nothing matches', () => {
  assert.deepEqual(extractLinkedIssueNumbers('Just a description, no linked issue.'), []);
  assert.deepEqual(extractLinkedIssueNumbers(''), []);
  assert.deepEqual(extractLinkedIssueNumbers(undefined), []);
});

test('extractLinkedIssueNumbers ignores a bare "#12" with no closing keyword', () => {
  assert.deepEqual(extractLinkedIssueNumbers('See #12 for context'), []);
});

// extractAcceptanceCriteria

test('extractAcceptanceCriteria pulls the section content', () => {
  const body = '### Task Summary\n\nDo the thing\n\n### Acceptance Criteria\n\n- Works on mobile\n- No console errors\n\n### Status\n\nBacklog';
  assert.equal(extractAcceptanceCriteria(body), '- Works on mobile\n- No console errors');
});

test('extractAcceptanceCriteria returns null when the section is missing', () => {
  assert.equal(extractAcceptanceCriteria('### Task Summary\n\nDo the thing'), null);
});

test('extractAcceptanceCriteria returns null when the section is empty', () => {
  assert.equal(extractAcceptanceCriteria('### Acceptance Criteria\n\n### Status\n\nBacklog'), null);
});

test('extractAcceptanceCriteria returns null for an empty body', () => {
  assert.equal(extractAcceptanceCriteria(''), null);
  assert.equal(extractAcceptanceCriteria(undefined), null);
});

// parseMergedPrNumber

test('parseMergedPrNumber recognizes a default merge commit message', () => {
  assert.equal(parseMergedPrNumber('Merge pull request #42 from owner/feature-branch'), 42);
});

test('parseMergedPrNumber recognizes a default squash commit message', () => {
  assert.equal(parseMergedPrNumber('Add burn-down chart (#42)'), 42);
});

test('parseMergedPrNumber only looks at the first line', () => {
  const message = 'Add burn-down chart (#42)\n\nSome body text mentioning (#99) that should not match';
  assert.equal(parseMergedPrNumber(message), 42);
});

test('parseMergedPrNumber returns null for a genuine direct push', () => {
  assert.equal(parseMergedPrNumber('Quick fix for typo in README'), null);
});

test('parseMergedPrNumber returns null for an empty message', () => {
  assert.equal(parseMergedPrNumber(''), null);
  assert.equal(parseMergedPrNumber(undefined), null);
});

// buildAutoTaskBody

test('buildAutoTaskBody notes the PR when not a direct push', () => {
  const body = buildAutoTaskBody({
    number: 12,
    title: 'Add dark mode',
    url: 'https://github.com/o/r/pull/12',
    author: 'devuser',
    viaDirectPush: false,
  });
  assert.match(body, /Opened as PR #12/);
  assert.match(body, /https:\/\/github\.com\/o\/r\/pull\/12/);
  assert.match(body, /devuser/);
  assert.match(body, /### Status\n\nIn Progress/);
});

test('buildAutoTaskBody notes the direct push when there is no PR', () => {
  const body = buildAutoTaskBody({
    number: null,
    title: 'Quick fix for typo in README',
    url: '',
    author: null,
    viaDirectPush: true,
  });
  assert.match(body, /direct push to `main`/);
  assert.match(body, /_unknown_/);
  assert.match(body, /No PR — direct push to main/);
});

// buildQaRequestBody

test('buildQaRequestBody fills every qa_request.yml field for a PR-backed request', () => {
  const body = buildQaRequestBody({
    relatedIssueNumber: 101,
    prNumber: 12,
    prTitle: 'Add dark mode',
    prUrl: 'https://github.com/o/r/pull/12',
    branch: 'feature/dark-mode',
    filesChanged: ['src/theme.ts', 'src/App.tsx'],
    acceptanceCriteria: '- Toggle persists across reload',
    originMarker: 'PR #12',
  });

  assert.match(body, /### Related Sprint Task Issue \(#\)\n\n#101/);
  assert.match(body, /PR #12: Add dark mode/);
  assert.match(body, /- `src\/theme\.ts`/);
  assert.match(body, /Branch: `feature\/dark-mode`/);
  assert.match(body, /Toggle persists across reload/);
  assert.match(body, /### QA Outcome\n\nPending/);
  assert.match(body, /origin: PR #12/);
});

test('buildQaRequestBody falls back to placeholders when nothing is known', () => {
  const body = buildQaRequestBody({
    relatedIssueNumber: 55,
    prNumber: null,
    prTitle: 'Quick fix for typo in README',
    prUrl: '',
    branch: 'main',
    filesChanged: [],
    acceptanceCriteria: null,
    originMarker: 'Direct push #abc123',
  });

  assert.match(body, /Landed via direct push/);
  assert.match(body, /None found on the linked issue/);
  assert.match(body, /origin: Direct push #abc123/);
});

// qaRequestAlreadyExists

test('qaRequestAlreadyExists finds a match by origin marker', () => {
  const existing = [{ body: 'Some body...\n\n*Auto-filed by Delivery OS — origin: PR #12*' }];
  assert.equal(qaRequestAlreadyExists(existing, 'PR #12'), true);
});

test('qaRequestAlreadyExists returns false when nothing matches', () => {
  const existing = [{ body: 'origin: PR #99' }];
  assert.equal(qaRequestAlreadyExists(existing, 'PR #12'), false);
});

test('qaRequestAlreadyExists returns false for an empty list', () => {
  assert.equal(qaRequestAlreadyExists([], 'PR #12'), false);
  assert.equal(qaRequestAlreadyExists(undefined, 'PR #12'), false);
});
