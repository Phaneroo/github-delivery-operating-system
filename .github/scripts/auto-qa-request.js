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

/**
 * A push can carry several commits, and the marker opts out one commit, not
 * the whole push: skip only when every commit in it is marked, so a trivial
 * marked commit on top can't hide real changes underneath.
 *
 * @param {string[]} messages - every commit message in the push
 * @returns {boolean}
 */
function allCommitsSkipped(messages) {
  return (messages || []).length > 0 && messages.every(hasSkipMarker);
}

/**
 * The text a direct push's issue links are read from: the head commit first
 * (its links win ties), then every other commit in the push, so a
 * `Refs #12` on an earlier commit still counts.
 *
 * @param {string} headMessage
 * @param {string[]} messages - every commit message in the push
 * @returns {string}
 */
function pushLinkText(headMessage, messages) {
  const rest = (messages || []).filter((m) => m !== headMessage);
  return [headMessage || '', ...rest].join('\n\n');
}

/**
 * Title for a direct push's filings: the newest commit that isn't marked
 * `[skip qa-request]` (a marked typo fix on top shouldn't name the work),
 * with any marker stripped.
 *
 * @param {string} headMessage
 * @param {string[]} messages - every commit message in the push, oldest first
 * @returns {string} a one-line title, or '' if there's nothing usable
 */
function pushTitle(headMessage, messages) {
  const unmarked = (messages || []).filter((m) => !hasSkipMarker(m));
  const source = hasSkipMarker(headMessage) && unmarked.length ? unmarked[unmarked.length - 1] : headMessage;
  return ((source || '').split('\n')[0] || '')
    .replace(/\s*\[skip qa-request\]\s*/gi, ' ')
    .trim();
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

// GitHub's compare and single-commit APIs return at most this many files.
const API_FILE_LIMIT = 300;

/**
 * A push's changed files have to come from the API: the push payload GitHub
 * Actions delivers has no `added`/`modified`/`removed` lists on its commits
 * (unlike the webhook docs suggest), so they can't be read from there.
 *
 * @param {Array<{ filename: string, previous_filename?: string }> | null} files
 *   - `files` from repos.compareCommitsWithBasehead / repos.getCommit
 * @returns {string[] | null} every path touched, including a rename's old
 *   path (moving src/ into docs/ isn't docs-only), deduplicated; null when
 *   unknown or possibly truncated, so callers never treat it as quiet.
 */
function touchedPathsFromApiFiles(files) {
  if (!files || !files.length || files.length >= API_FILE_LIMIT) return null;
  const paths = new Set();
  for (const f of files) {
    paths.add(f.filename);
    if (f.previous_filename) paths.add(f.previous_filename);
  }
  return [...paths];
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

// ---------------------------------------------------------------------------
// Settings: DELIVERY_OS_AUTO_QA_MODE (new) + DELIVERY_OS_AUTO_QA (1.8.0)
// ---------------------------------------------------------------------------

const QA_STYLES = ['rolling', 'per-change', 'off'];

/**
 * @param {string | undefined} modeVar - DELIVERY_OS_AUTO_QA_MODE
 * @param {string | undefined} legacyVar - DELIVERY_OS_AUTO_QA (1.8.0)
 * @returns {{ style: 'rolling' | 'per-change' | 'off', prOnly: boolean }}
 *   An explicit, valid MODE wins. Otherwise the 1.8.0 variable keeps its
 *   meaning where it was set explicitly: `all` → per-change (the behavior
 *   that repo chose), `off` → off. Unset or unrecognized → `rolling`, the
 *   new default; a typo never turns the reminder off. `pr-only` still means
 *   "direct pushes add nothing", whatever the style.
 */
function resolveQaSettings(modeVar, legacyVar) {
  const mode = (modeVar || '').trim().toLowerCase();
  const legacy = (legacyVar || '').trim().toLowerCase();
  let style = 'rolling';
  if (QA_STYLES.includes(mode)) style = mode;
  else if (legacy === 'off') style = 'off';
  else if (legacy === 'all') style = 'per-change';
  return { style, prOnly: legacy === 'pr-only' };
}

// ---------------------------------------------------------------------------
// Rolling QA issue: one open auto-filed QA issue per repo, one checklist line
// per change that reaches main. Approved/declined by QA_APPROVER via
// qa-rollup-approval.yml.
// ---------------------------------------------------------------------------

const ROLLING_TITLE = 'QA REQUEST - Changes awaiting QA';
const ROLLING_LABELS = ['qa-request', 'delivery-ops-filed', 'qa-rollup'];
const CHANGES_START = '<!-- delivery-os:changes:start -->';
const CHANGES_END = '<!-- delivery-os:changes:end -->';
const APPROVAL_BOX = 'Approved: all changes above have been tested';
// Deliberately NOT the per-change "— origin: " footer, so release-time
// auto-close and per-change lookups never mistake this issue for one of theirs.
const ROLLING_FOOTER = '*Auto-filed by Delivery OS — rolling QA issue (one list of changes awaiting QA)*';

const originTag = (originMarker) => `<!-- delivery-os:origin=${originMarker} -->`;

/**
 * One checklist entry: the change's title and reference, plus its
 * plain-English draft bullets indented underneath for the dev to edit.
 *
 * @param {{ title: string, ref: string, author: string | null,
 *   linkedIssue: number | null, originMarker: string, summary?: string }} change
 *   - ref: short sha or `#PR`; summary: seedChangeSummary output
 * @returns {string}
 */
function buildChangeLine({ title, ref, author, linkedIssue, originMarker, summary }) {
  const by = author ? ` by @${author}` : '';
  const forIssue = linkedIssue ? ` — for #${linkedIssue}` : '';
  const head = `- [ ] ${title} (${ref})${by}${forIssue} ${originTag(originMarker)}`;
  const cleanTitle = (title || '').trim().toLowerCase();
  const bullets = (summary || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') && l.slice(2).trim().toLowerCase() !== cleanTitle);
  return [head, ...bullets.map((b) => `  ${b}`)].join('\n');
}

/**
 * @param {string} firstChange - a buildChangeLine block
 * @returns {string} the rolling issue body, qa_request.yml field headings included
 */
function buildRollingQaBody(firstChange) {
  return [
    '### Related Sprint Task Issue (#)',
    '',
    '_Rolling QA issue — each change below names its own issue, if it has one._',
    '',
    '### What Changed (plain English)',
    '',
    'One line per change that reached `main` since the last QA approval. The bullets under each line are a draft built from commit messages: devs, edit them into plain English (what a user will notice, and what could break).',
    '',
    '### Changes',
    '',
    CHANGES_START,
    firstChange,
    CHANGES_END,
    '',
    '### What to Test',
    '',
    'Each change above. Tick a line once it has been tested.',
    '',
    '### Environment + Build Link',
    '',
    'Branch: `main`',
    '',
    '### Acceptance Criteria',
    '',
    "_Per change — see each line's linked issue._",
    '',
    '### QA Outcome',
    '',
    'Pending',
    '',
    '### QA Approval',
    '',
    `- [ ] ${APPROVAL_BOX}`,
    '',
    '_Only the QA approver can approve or decline: tick the box above, or comment starting with e.g. `approved`, `lgtm`, `looks good` or ✅ to approve, or `declined`, `needs work`, `not ok` or ❌ to decline._',
    '',
    '---',
    ROLLING_FOOTER,
  ].join('\n');
}

/**
 * @param {string} body - a rolling issue body
 * @param {string} originMarker - e.g. `PR #12` or `Direct push #<sha>`
 * @returns {boolean} whether that change is already on the list
 */
function hasChange(body, originMarker) {
  return (body || '').includes(originTag(originMarker));
}

/**
 * @param {string} body
 * @param {string} block - a buildChangeLine block
 * @returns {string} body with the block added at the end of the checklist
 */
function appendChange(body, block) {
  const b = body || '';
  const end = b.indexOf(CHANGES_END);
  if (end !== -1) return `${b.slice(0, end)}${block}\n${b.slice(end)}`;
  // Markers edited away: keep the change rather than drop it.
  const footer = b.lastIndexOf('\n---\n');
  return footer !== -1 ? `${b.slice(0, footer)}\n${block}\n${b.slice(footer)}` : `${b}\n${block}`;
}

/**
 * @param {string} body
 * @returns {Array<{ originMarker: string, checked: boolean, text: string,
 *   bullets: string[], block: string }>} every change on the list, in order
 */
function parseChanges(body) {
  const changes = [];
  let current = null; // the entry whose indented bullets we're collecting
  for (const line of (body || '').split('\n')) {
    const head = line.match(/^- \[([ xX])\] (.*?)\s*<!-- delivery-os:origin=(.*?) -->\s*$/);
    if (head) {
      current = { originMarker: head[3], checked: head[1] !== ' ', text: head[2], bullets: [], block: line };
      changes.push(current);
    } else if (current && /^\s+- /.test(line)) {
      current.bullets.push(line.trim());
      current.block += `\n${line}`;
    } else {
      current = null;
    }
  }
  return changes;
}

const APPROVAL_LINE_RE = new RegExp(`^- \\[([ xX])\\] ${APPROVAL_BOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');

/**
 * @param {string} body
 * @returns {boolean} whether the Approved box is ticked
 */
function approvalBoxTicked(body) {
  const m = (body || '').match(APPROVAL_LINE_RE);
  return Boolean(m && m[1] !== ' ');
}

/**
 * @param {string | undefined} oldBody - `changes.body.from` of an issues.edited event
 * @param {string} newBody
 * @returns {boolean} whether this edit is the one that ticked the Approved box
 */
function approvalBoxJustTicked(oldBody, newBody) {
  return typeof oldBody === 'string' && !approvalBoxTicked(oldBody) && approvalBoxTicked(newBody);
}

const setApprovalBox = (body, ticked) =>
  (body || '').replace(APPROVAL_LINE_RE, `- [${ticked ? 'x' : ' '}] ${APPROVAL_BOX}`);

/**
 * @param {string} body
 * @param {string} outcome - Pass / Fail / Pending
 * @returns {string}
 */
function setQaOutcome(body, outcome) {
  return (body || '').replace(/(### QA Outcome\n\n)[^\n]*/, `$1${outcome}`);
}

/**
 * @param {string} body
 * @returns {string} body as approved: every change ticked, Approved box
 *   ticked, QA Outcome Pass
 */
function markRollingApproved(body) {
  const ticked = (body || '')
    .split('\n')
    .map((l) => (/^- \[ \] .*<!-- delivery-os:origin=/.test(l) ? l.replace('- [ ] ', '- [x] ') : l))
    .join('\n');
  return setQaOutcome(setApprovalBox(ticked, true), 'Pass');
}

/**
 * @param {string} body
 * @returns {string} body as declined: Approved box cleared, QA Outcome Fail
 */
function markRollingDeclined(body) {
  return setQaOutcome(setApprovalBox(body, false), 'Fail');
}

/**
 * @param {string} body
 * @returns {string} body with the Approved box cleared (a non-approver ticked it)
 */
function untickApprovalBox(body) {
  return setApprovalBox(body, false);
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
  allCommitsSkipped,
  pushLinkText,
  pushTitle,
  resolveAutoQaMode,
  shouldFileForEvent,
  autoTaskEnabledForDirectPush,
  DEFAULT_QUIET_PATHS,
  resolveQuietPaths,
  globToRegExp,
  isQuietChange,
  touchedPathsFromApiFiles,
  resolveQaSettings,
  ROLLING_TITLE,
  ROLLING_LABELS,
  ROLLING_FOOTER,
  APPROVAL_BOX,
  buildChangeLine,
  buildRollingQaBody,
  hasChange,
  appendChange,
  parseChanges,
  approvalBoxTicked,
  approvalBoxJustTicked,
  setQaOutcome,
  markRollingApproved,
  markRollingDeclined,
  untickApprovalBox,
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
