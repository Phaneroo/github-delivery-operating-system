'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');
const {
  extractLinkedIssueNumbers,
  extractCommitIssueReferences,
  hasSkipMarker,
  resolveAutoQaMode,
  shouldFileForEvent,
  autoTaskEnabledForDirectPush,
  DEFAULT_QUIET_PATHS,
  resolveQuietPaths,
  globToRegExp,
  isQuietChange,
  collectPushedFiles,
  findFilingsForPr,
  CHANGELOG_REVIEW_BOX,
  seedChangeSummary,
  isChangelogReviewed,
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

// extractCommitIssueReferences

test('extractCommitIssueReferences finds closing keywords, Refs and bare #N', () => {
  assert.deepEqual(extractCommitIssueReferences('Tighten copy\n\nCloses #27'), [27]);
  assert.deepEqual(extractCommitIssueReferences('Tighten copy\n\nRefs #27'), [27]);
  assert.deepEqual(extractCommitIssueReferences('Tighten copy for #27'), [27]);
});

test('extractCommitIssueReferences puts closing-keyword references first', () => {
  assert.deepEqual(extractCommitIssueReferences('Follow-up to #3\n\nFixes #9, see also #4'), [9, 3, 4]);
});

test('extractCommitIssueReferences dedupes repeated references', () => {
  assert.deepEqual(extractCommitIssueReferences('Closes #12 (refs #12)'), [12]);
});

test('extractCommitIssueReferences ignores cross-repo refs, URL fragments and ##N', () => {
  assert.deepEqual(extractCommitIssueReferences('Port owner/repo#12 fix'), []);
  assert.deepEqual(extractCommitIssueReferences('See https://example.com/page#12'), []);
  assert.deepEqual(extractCommitIssueReferences('Rename ##12 heading'), []);
  assert.deepEqual(extractCommitIssueReferences('Bump color #fff'), []);
});

test('extractCommitIssueReferences returns [] when nothing matches', () => {
  assert.deepEqual(extractCommitIssueReferences('Quick fix for typo in README'), []);
  assert.deepEqual(extractCommitIssueReferences(''), []);
  assert.deepEqual(extractCommitIssueReferences(undefined), []);
});

// hasSkipMarker

test('hasSkipMarker detects [skip qa-request] anywhere, case-insensitively', () => {
  assert.equal(hasSkipMarker('Fix typo [skip qa-request]'), true);
  assert.equal(hasSkipMarker('Fix typo\n\n[Skip QA-Request]'), true);
});

test('hasSkipMarker ignores other skip phrases', () => {
  assert.equal(hasSkipMarker('Fix typo [skip ci]'), false);
  assert.equal(hasSkipMarker('Fix typo [skip qa]'), false);
  assert.equal(hasSkipMarker(''), false);
  assert.equal(hasSkipMarker(undefined), false);
});

// resolveAutoQaMode / shouldFileForEvent

test('resolveAutoQaMode defaults to all when unset', () => {
  assert.equal(resolveAutoQaMode(undefined), 'all');
  assert.equal(resolveAutoQaMode(''), 'all');
});

test('resolveAutoQaMode normalizes case and whitespace', () => {
  assert.equal(resolveAutoQaMode(' PR-Only '), 'pr-only');
  assert.equal(resolveAutoQaMode('OFF'), 'off');
  assert.equal(resolveAutoQaMode('all'), 'all');
});

test('resolveAutoQaMode falls back to all for unrecognized values', () => {
  assert.equal(resolveAutoQaMode('none'), 'all');
  assert.equal(resolveAutoQaMode('pronly'), 'all');
});

test('shouldFileForEvent: all files for PRs and pushes', () => {
  assert.equal(shouldFileForEvent('all', 'pull_request'), true);
  assert.equal(shouldFileForEvent('all', 'push'), true);
});

test('shouldFileForEvent: pr-only files for PRs but not direct pushes', () => {
  assert.equal(shouldFileForEvent('pr-only', 'pull_request'), true);
  assert.equal(shouldFileForEvent('pr-only', 'push'), false);
});

test('shouldFileForEvent: off files nothing', () => {
  assert.equal(shouldFileForEvent('off', 'pull_request'), false);
  assert.equal(shouldFileForEvent('off', 'push'), false);
});

// autoTaskEnabledForDirectPush

test('autoTaskEnabledForDirectPush is on unless explicitly false', () => {
  assert.equal(autoTaskEnabledForDirectPush(undefined), true);
  assert.equal(autoTaskEnabledForDirectPush(''), true);
  assert.equal(autoTaskEnabledForDirectPush('true'), true);
  assert.equal(autoTaskEnabledForDirectPush('false'), false);
  assert.equal(autoTaskEnabledForDirectPush(' FALSE '), false);
});

// resolveQuietPaths / globToRegExp / isQuietChange

test('resolveQuietPaths uses the defaults when unset, none disables, a list replaces', () => {
  assert.deepEqual(resolveQuietPaths(undefined), DEFAULT_QUIET_PATHS);
  assert.deepEqual(resolveQuietPaths(' NONE '), []);
  assert.deepEqual(resolveQuietPaths('docs/**, *.txt\nconfig/*.json'), ['docs/**', '*.txt', 'config/*.json']);
});

test('globToRegExp: ** crosses directories (and matches the root), * does not', () => {
  assert.equal(globToRegExp('**/*.md').test('README.md'), true);
  assert.equal(globToRegExp('**/*.md').test('a/b/NOTES.md'), true);
  assert.equal(globToRegExp('docs/**').test('docs/a/b.html'), true);
  assert.equal(globToRegExp('*.md').test('a/README.md'), false);
  assert.equal(globToRegExp('LICENSE*').test('LICENSE.txt'), true);
  assert.equal(globToRegExp('.github/ISSUE_TEMPLATE/**').test('.github/workflows/x.yml'), false);
});

test('isQuietChange: README / docs / settings-only changes are quiet by default', () => {
  assert.equal(isQuietChange(['README.md'], DEFAULT_QUIET_PATHS), true);
  assert.equal(isQuietChange(['docs/setup.md', 'docs/index.html', '.editorconfig'], DEFAULT_QUIET_PATHS), true);
  assert.equal(isQuietChange(['.vscode/settings.json', '.gitignore'], DEFAULT_QUIET_PATHS), true);
});

test('isQuietChange: any code, workflow or script change is not quiet', () => {
  assert.equal(isQuietChange(['README.md', 'src/app.js'], DEFAULT_QUIET_PATHS), false);
  assert.equal(isQuietChange(['.github/workflows/ci.yml'], DEFAULT_QUIET_PATHS), false);
  assert.equal(isQuietChange(['package.json'], DEFAULT_QUIET_PATHS), false);
});

test('isQuietChange: an unknown or empty file list, or no globs, is never quiet', () => {
  assert.equal(isQuietChange(null, DEFAULT_QUIET_PATHS), false);
  assert.equal(isQuietChange([], DEFAULT_QUIET_PATHS), false);
  assert.equal(isQuietChange(['README.md'], []), false);
});

// collectPushedFiles

test('collectPushedFiles unions added/modified/removed across commits', () => {
  const commits = [
    { added: ['a.md'], modified: ['README.md'], removed: [] },
    { added: [], modified: ['README.md'], removed: ['src/old.js'] },
  ];
  assert.deepEqual(collectPushedFiles(commits).sort(), ['README.md', 'a.md', 'src/old.js']);
});

test('collectPushedFiles returns null when file lists are missing or there are no commits', () => {
  assert.equal(collectPushedFiles([{ added: ['a.md'] }]), null);
  assert.equal(collectPushedFiles([]), null);
  assert.equal(collectPushedFiles(undefined), null);
});

// findFilingsForPr

test('findFilingsForPr finds the Task and QA Request auto-filed for a PR, and nothing else', () => {
  const task = { number: 1, body: buildAutoTaskBody({ number: 2, title: 't', url: 'https://x/pull/2', author: 'a', viaDirectPush: false }) };
  const qa = { number: 3, body: buildQaRequestBody({ relatedIssueNumber: 1, prNumber: 2, prTitle: 't', prUrl: '', branch: 'b', filesChanged: [], acceptanceCriteria: null, originMarker: 'PR #2' }) };
  const otherPr = { number: 4, body: buildQaRequestBody({ relatedIssueNumber: 1, prNumber: 21, prTitle: 't', prUrl: '', branch: 'b', filesChanged: [], acceptanceCriteria: null, originMarker: 'PR #21' }) };
  const human = { number: 5, body: 'Mentions PR #2 in passing' };
  assert.deepEqual(findFilingsForPr([task, qa, otherPr, human], 2), [1, 3]);
});

// seedChangeSummary / isChangelogReviewed

test('seedChangeSummary turns commit subjects into clean bullets', () => {
  const summary = seedChangeSummary({
    title: 'ignored',
    commitMessages: [
      'Add dark mode toggle (#12)\n\nLong body',
      'Fix login redirect, closes #4 [skip qa-request]',
      'Refs #9: tidy settings page',
    ],
  });
  assert.equal(summary, '- Add dark mode toggle\n- Fix login redirect\n- tidy settings page');
});

test('seedChangeSummary drops merge/fixup commits and case-insensitive duplicates', () => {
  const summary = seedChangeSummary({
    title: 'ignored',
    commitMessages: ['Add export', 'Merge branch main into feature', 'fixup! Add export', 'add export'],
  });
  assert.equal(summary, '- Add export');
});

test('seedChangeSummary falls back to the title when there are no usable commits', () => {
  assert.equal(seedChangeSummary({ title: 'Add dark mode (#12)', commitMessages: [] }), '- Add dark mode');
  assert.equal(seedChangeSummary({ title: '', commitMessages: undefined }), '- Describe what changed');
});

test('seedChangeSummary caps the list at 10 bullets', () => {
  const commitMessages = Array.from({ length: 13 }, (_, i) => `Change ${i + 1}`);
  const lines = seedChangeSummary({ title: 't', commitMessages }).split('\n');
  assert.equal(lines.length, 11);
  assert.equal(lines[10], '- …and 3 more commit(s)');
});

test('buildQaRequestBody includes the plain-English changelog and an unticked dev-review box', () => {
  const body = buildQaRequestBody({
    relatedIssueNumber: 1, prNumber: 2, prTitle: 'Add export', prUrl: '', branch: 'b',
    filesChanged: [], acceptanceCriteria: null, originMarker: 'PR #2',
    changeSummary: '- Add export',
  });
  assert.match(body, /### What Changed \(plain English\)\n\n- Add export\n\n_Draft/);
  assert.match(body, /### Changelog Review\n\n- \[ \] Dev reviewed/);
  assert.equal(isChangelogReviewed(body), false);
  assert.ok(body.indexOf('What Changed') < body.indexOf('What to Test'), 'changelog should come before What to Test');
});

test('isChangelogReviewed is true only once a dev ticks the box', () => {
  assert.equal(isChangelogReviewed(`- [x] ${CHANGELOG_REVIEW_BOX}`), true);
  assert.equal(isChangelogReviewed(`- [X] ${CHANGELOG_REVIEW_BOX}`), true);
  assert.equal(isChangelogReviewed(`- [ ] ${CHANGELOG_REVIEW_BOX}`), false);
  assert.equal(isChangelogReviewed(''), false);
});

test('qa_request.yml template uses the same review checkbox text the workflow writes', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', '.github', 'ISSUE_TEMPLATE', 'qa_request.yml'), 'utf8');
  assert.ok(template.includes(`label: "${CHANGELOG_REVIEW_BOX}"`));
  assert.ok(template.includes('label: "What Changed (plain English)"'));
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

test('buildQaRequestBody says so when no related issue exists', () => {
  const body = buildQaRequestBody({
    relatedIssueNumber: null,
    prNumber: null,
    prTitle: 'Quick fix for typo in README',
    prUrl: '',
    branch: 'main',
    filesChanged: [],
    acceptanceCriteria: null,
    originMarker: 'Direct push #abc123',
  });

  assert.match(body, /### Related Sprint Task Issue \(#\)\n\n_None — no issue was linked to this work\._/);
  assert.doesNotMatch(body, /#null/);
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

test('qaRequestAlreadyExists does not confuse PR #2 with PR #21', () => {
  const existing = [{ body: '*Auto-filed by Delivery OS — origin: PR #21*' }];
  assert.equal(qaRequestAlreadyExists(existing, 'PR #2'), false);
});

test('buildQaRequestBody lists files for a direct push when they are known', () => {
  const body = buildQaRequestBody({
    relatedIssueNumber: 5, prNumber: null, prTitle: 'Tweak', prUrl: '', branch: 'main',
    filesChanged: ['src/a.js'], acceptanceCriteria: null, originMarker: 'Direct push #abc',
  });
  assert.match(body, /Files changed:\n- `src\/a\.js`/);
});

test('qaRequestAlreadyExists returns false for an empty list', () => {
  assert.equal(qaRequestAlreadyExists([], 'PR #12'), false);
  assert.equal(qaRequestAlreadyExists(undefined, 'PR #12'), false);
});
