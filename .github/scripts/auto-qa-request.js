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

/**
 * @param {{ relatedIssueNumber: number, prNumber: number | null,
 *   prTitle: string, prUrl: string, branch: string, filesChanged: string[],
 *   acceptanceCriteria: string | null, originMarker: string }} params
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
}) {
  const filesList = (filesChanged || []).length
    ? filesChanged.map((f) => `- \`${f}\``).join('\n')
    : '_File list unavailable._';

  const whatToTest = prNumber
    ? `PR #${prNumber}: ${prTitle}\n\nFiles changed:\n${filesList}\n\n_Auto-generated starter list — fill in the actual test scenarios._`
    : `${prTitle}\n\n_Landed via direct push — no PR diff available. Fill in what changed and what to test._`;

  return [
    '### Related Sprint Task Issue (#)',
    '',
    `#${relatedIssueNumber}`,
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
  return (openQaRequests || []).some((issue) => (issue.body || '').includes(originMarker));
}

module.exports = {
  extractLinkedIssueNumbers,
  extractAcceptanceCriteria,
  parseMergedPrNumber,
  buildAutoTaskBody,
  buildQaRequestBody,
  qaRequestAlreadyExists,
};
