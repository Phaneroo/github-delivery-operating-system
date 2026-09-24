'use strict';

// Pure parsing/body-building logic for auto-qa-request.yml, extracted so it
// can be unit tested directly (see test/auto-qa-request.test.js) instead of
// only verified by hand.

const CLOSING_KEYWORD_RE = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*#(\d+)/gi;

/**
 * @param {string} text - a PR body
 * @returns {number[]} issue numbers referenced via GitHub's closing-keyword
 *   syntax ("Closes #12", "Fixes #7", etc.), in the order they appear,
 *   deduplicated.
 */
function extractLinkedIssueNumbers(text) {
  const numbers = [];
  for (const match of (text || '').matchAll(CLOSING_KEYWORD_RE)) {
    const n = parseInt(match[1], 10);
    if (!numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

// A same-repo `#N` reference: not preceded by a word character, `/` or `#`,
// so cross-repo refs (`owner/repo#12`), URL fragments and `##12` don't match.
const ISSUE_REFERENCE_RE = /(?<![\w/#])#(\d+)\b/g;

/**
 * Direct pushes have no PR body, so their issue links live in the commit
 * message — and commit messages commonly use `Refs #12` or a bare `#12`, not
 * just closing keywords.
 *
 * @param {string} message - a commit message
 * @returns {number[]} every same-repo `#N` referenced, closing-keyword
 *   references first (they're the strongest signal of which issue the
 *   commit is for), then the rest in order of appearance, deduplicated.
 */
function extractCommitIssueReferences(message) {
  const numbers = extractLinkedIssueNumbers(message);
  for (const match of (message || '').matchAll(ISSUE_REFERENCE_RE)) {
    const n = parseInt(match[1], 10);
    if (!numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

const SKIP_MARKER = '[skip qa-request]';

/**
 * Per-commit opt-out for trivial direct pushes. Deliberately specific to this
 * workflow — not `[skip ci]` (GitHub-reserved, skips every workflow) or a
 * generic phrase like `[skip qa]` a repo may already use for something else.
 *
 * @param {string} message - a commit message
 * @returns {boolean}
 */
function hasSkipMarker(message) {
  return (message || '').toLowerCase().includes(SKIP_MARKER);
}

const AUTO_QA_MODES = ['all', 'pr-only', 'off'];

/**
 * @param {string | undefined} value - the `DELIVERY_OS_AUTO_QA` repo variable
 * @returns {'all' | 'pr-only' | 'off'} the normalized mode; unset or
 *   unrecognized values fall back to `all` (the pre-variable behavior), so a
 *   typo never silently turns the safety net off.
 */
function resolveAutoQaMode(value) {
  const mode = (value || '').trim().toLowerCase();
  return AUTO_QA_MODES.includes(mode) ? mode : 'all';
}

/**
 * @param {'all' | 'pr-only' | 'off'} mode - from resolveAutoQaMode
 * @param {string} eventName - `pull_request` or `push`
 * @returns {boolean} whether this event should file anything at all
 */
function shouldFileForEvent(mode, eventName) {
  if (mode === 'off') return false;
  if (mode === 'pr-only') return eventName === 'pull_request';
  return true;
}

/**
 * @param {string | undefined} value - the `DELIVERY_OS_AUTO_TASK` repo variable
 * @returns {boolean} whether a direct push with no linked issue should get a
 *   synthetic Task; only an explicit `false` turns it off.
 */
function autoTaskEnabledForDirectPush(value) {
  return (value || '').trim().toLowerCase() !== 'false';
}

// Changes that don't need a QA pass: docs, licenses, editor/repo settings,
// and the issue templates themselves. Workflows and scripts are deliberately
// NOT here — they change behavior.
const DEFAULT_QUIET_PATHS = [
  '**/*.md',
  'docs/**',
  'LICENSE*',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.vscode/**',
  '.idea/**',
  '.github/ISSUE_TEMPLATE/**',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
];

/**
 * @param {string | undefined} value - the `DELIVERY_OS_AUTO_QA_QUIET_PATHS`
 *   repo variable: comma- or newline-separated globs
 * @returns {string[]} the defaults when unset, [] for `none`, otherwise the
 *   given globs (replacing the defaults, not adding to them)
 */
function resolveQuietPaths(value) {
  const raw = (value || '').trim();
  if (!raw) return DEFAULT_QUIET_PATHS.slice();
  if (raw.toLowerCase() === 'none') return [];
  return raw.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Minimal glob → RegExp: `**` matches across `/`, `*` within one segment,
 * `?` one character; a leading `**\/` also matches at the repo root.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string[] | null} files - every path the PR/push touched, or null
 *   if unknown
 * @param {string[]} quietPaths - globs from resolveQuietPaths
 * @returns {boolean} true only when the file list is known, non-empty, and
 *   every file matches a quiet glob — an unknown list always gets filed.
 */
function isQuietChange(files, quietPaths) {
  if (!files || !files.length || !quietPaths.length) return false;
  const res = quietPaths.map(globToRegExp);
  return files.every((f) => res.some((re) => re.test(f)));
}

/**
 * @param {Array<{ added?: string[], modified?: string[], removed?: string[] }>} commits
 *   - a push event's `commits` payload
 * @returns {string[] | null} every path touched, deduplicated, or null if
 *   any commit is missing its file lists (so callers treat it as unknown).
 */
function collectPushedFiles(commits) {
  if (!commits || !commits.length) return null;
  const files = new Set();
  for (const commit of commits) {
    if (!commit.added || !commit.modified || !commit.removed) return null;
    for (const f of [...commit.added, ...commit.modified, ...commit.removed]) files.add(f);
  }
  return [...files];
}

/**
 * When a PR is closed without merging, its work never reaches `main`, so the
 * Task/QA Request auto-filed for it are dead weight. Finds them by the exact
 * markers buildAutoTaskBody/buildQaRequestBody write.
 *
 * @param {Array<{ number: number, body: string }>} openIssues
 * @param {number} prNumber
 * @returns {number[]} issue numbers auto-filed for this PR
 */
function findFilingsForPr(openIssues, prNumber) {
  const qaMarker = new RegExp(`origin: PR #${prNumber}(?!\\d)`);
  const taskMarker = new RegExp(`Opened as PR #${prNumber} \\(`);
  return (openIssues || [])
    .filter((issue) => qaMarker.test(issue.body || '') || taskMarker.test(issue.body || ''))
    .map((issue) => issue.number);
}

/**
 * @param {string} body - an issue body (typically a Task issue)
 * @returns {string | null} the text under "### Acceptance Criteria", or null
 *   if that section doesn't exist or is empty.
 */
function extractAcceptanceCriteria(body) {
  const match = (body || '').match(/### Acceptance Criteria[\s\S]*?(?=###|$)/);
  if (!match) return null;
  const content = match[0].replace(/### Acceptance Criteria/, '').trim();
  return content || null;
}

/**
 * A push to `main` fires even when it's GitHub merging (or squash-merging) a
 * PR that the `pull_request` trigger already handled. Detects that so the
 * push handler can skip it instead of filing a duplicate Task + QA Request
 * for work that's already tracked.
 *
 * @param {string} commitMessage - the push event's head commit message
 * @returns {number | null} the merged PR's number, or null if this doesn't
 *   look like a merge/squash of a PR (e.g. a genuine direct push, or a
 *   rebase-merge commit, which carries no reliable marker).
 */
function parseMergedPrNumber(commitMessage) {
  const firstLine = (commitMessage || '').split('\n')[0];

  const mergeMatch = firstLine.match(/^Merge pull request #(\d+) from/);
  if (mergeMatch) return parseInt(mergeMatch[1], 10);

  const squashMatch = firstLine.match(/\(#(\d+)\)$/);
  if (squashMatch) return parseInt(squashMatch[1], 10);

  return null;
}

/**
 * @param {{ number: number | null, title: string, url: string,
 *   author: string | null, viaDirectPush: boolean }} params
 * @returns {string} body for an auto-filed Task issue tracking work that
 *   reached `main` (via PR or direct push) with no pre-existing issue.
 */
function buildAutoTaskBody({ number, title, url, author, viaDirectPush }) {
  const origin = viaDirectPush
    ? 'Landed via a direct push to `main` with no pull request.'
    : `Opened as PR #${number} (${url}) with no linked issue.`;

  return [
    '### Task Summary',
    '',
    title,
    '',
    '### Description',
    '',
    `${origin} Auto-filed so this work has a paper trail and can be QA'd — fill in the real scope/owner/priority.`,
    '',
    '### Owner',
    '',
    author || '_unknown_',
    '',
    '### Priority',
    '',
    'P2 - Medium',
    '',
    '### Status',
    '',
    'In Progress',
    '',
    '### Acceptance Criteria',
    '',
    '_Not specified — filed automatically, backfill before closing._',
    '',
    '### Artifacts / Links',
    '',
    viaDirectPush ? '_No PR — direct push to main._' : `PR: ${url}`,
    '',
    '---',
    '*Auto-filed by Delivery OS (no issue was linked when this work reached main)*',
  ].join('\n');
}

const CHANGELOG_HEADING = '### What Changed (plain English)';
const CHANGELOG_REVIEW_HEADING = '### Changelog Review';
const CHANGELOG_REVIEW_BOX = 'Dev reviewed: this describes the change accurately, in plain English';
const CHANGELOG_DRAFT_NOTE =
  '_Draft built from commit messages. Dev: rewrite it in plain English (what a user will notice, and what could break), then tick the box below so QA knows it can rely on it._';

/**
 * Seeds the QA Request's plain-English changelog with the closest thing
 * the workflow has to a human description, the commit subjects, as a
 * clearly marked draft for a dev (or the delivery-ops skill) to rewrite.
 * Drops merge commits, fixup/squash noise, `[skip …]` markers and trailing
 * `(#N)` / closing-keyword clutter so the draft reads as change notes.
 *
 * @param {{ title: string, commitMessages?: string[] }} params
 * @returns {string} a bullet list, at most 10 items
 */
function seedChangeSummary({ title, commitMessages }) {
  const clean = (line) =>
    line
      .replace(/\[skip [^\]]*\]/gi, '')
      .replace(/\s*\(#\d+\)\s*$/, '')
      .replace(/\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|refs?)\s*:?\s*#\d+/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '')
      .trim();

  const bullets = [];
  for (const message of commitMessages || []) {
    const subject = clean((message || '').split('\n')[0]);
    if (!subject || /^(merge\b|fixup!|squash!)/i.test(subject)) continue;
    if (!bullets.some((b) => b.toLowerCase() === subject.toLowerCase())) bullets.push(subject);
  }
  if (!bullets.length) bullets.push(clean(title || '') || 'Describe what changed');

  const shown = bullets.slice(0, 10).map((b) => `- ${b}`);
  if (bullets.length > 10) shown.push(`- …and ${bullets.length - 10} more commit(s)`);
  return shown.join('\n');
}

/**
 * @param {string} body - a QA Request body
 * @returns {boolean} whether a dev has ticked the changelog-review box
 */
function isChangelogReviewed(body) {
  const escaped = CHANGELOG_REVIEW_BOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`- \\[[xX]\\] ${escaped}`).test(body || '');
}

/**
 * @param {{ relatedIssueNumber: number | null, prNumber: number | null,
 *   prTitle: string, prUrl: string, branch: string, filesChanged: string[],
 *   acceptanceCriteria: string | null, originMarker: string,
 *   changeSummary?: string }} params - changeSummary from seedChangeSummary
 * @returns {string} body for an auto-filed QA Request issue, matching
 *   qa_request.yml's field headings.
 */
function buildQaRequestBody({
  relatedIssueNumber,
  prNumber,
  prTitle,
  prUrl,
  branch,
  filesChanged,
  acceptanceCriteria,
  originMarker,
  changeSummary,
}) {
  const filesList = (filesChanged || []).length
    ? filesChanged.map((f) => `- \`${f}\``).join('\n')
    : '_File list unavailable._';

  const whatToTest = prNumber
    ? `PR #${prNumber}: ${prTitle}\n\nFiles changed:\n${filesList}\n\n_Auto-generated starter list — fill in the actual test scenarios._`
    : (filesChanged || []).length
      ? `${prTitle}\n\nFiles changed:\n${filesList}\n\n_Landed via direct push — fill in what to test._`
      : `${prTitle}\n\n_Landed via direct push — no PR diff available. Fill in what changed and what to test._`;

  return [
    '### Related Sprint Task Issue (#)',
    '',
    relatedIssueNumber ? `#${relatedIssueNumber}` : '_None — no issue was linked to this work._',
    '',
    CHANGELOG_HEADING,
    '',
    changeSummary || seedChangeSummary({ title: prTitle }),
    '',
    CHANGELOG_DRAFT_NOTE,
    '',
    CHANGELOG_REVIEW_HEADING,
    '',
    `- [ ] ${CHANGELOG_REVIEW_BOX}`,
    '',
    '### What to Test',
    '',
    whatToTest,
    '',
    '### Environment + Build Link',
    '',
    `Branch: \`${branch}\`${prUrl ? `\nPR: ${prUrl}` : ''}`,
    '',
    '### Acceptance Criteria',
    '',
    acceptanceCriteria || '_None found on the linked issue — fill in before testing._',
    '',
    '### QA Outcome',
    '',
    'Pending',
    '',
    '---',
    `*Auto-filed by Delivery OS — origin: ${originMarker}*`,
  ].join('\n');
}

/**
 * Idempotency check: has a QA Request already been filed for this PR/push?
 *
 * @param {Array<{ body: string }>} openQaRequests - open issues labeled qa-request
 * @param {string} originMarker - e.g. `PR #12` or `Direct push #<sha>`
 * @returns {boolean}
 */
function qaRequestAlreadyExists(openQaRequests, originMarker) {
  // Anchored on the footer and a non-digit after the marker, so `PR #2`
  // doesn't match a request filed for PR #21.
  const escaped = originMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`origin: ${escaped}(?![\\w])`);
  return (openQaRequests || []).some((issue) => re.test(issue.body || ''));
}

module.exports = {
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
};
