'use strict';

// Pure logic for the release roll-up posted by notify-release-approver.yml:
// one comment on a Production Release issue collecting the plain-English
// "What Changed" notes from every QA Request the release likely covers, so
// approvers can see what they're signing off. Informational only: nothing
// here blocks authorization. Unit tested in test/release-rollup.test.js.

const ROLLUP_MARKER = '<!-- delivery-os:release-rollup -->';
const MAX_ITEMS = 30;

// Mirrors CHANGELOG_REVIEW_BOX / the draft note in auto-qa-request.js and
// qa_request.yml. Copied rather than required so this workflow only needs
// its own script; test/release-rollup.test.js fails if they drift apart.
const REVIEW_BOX = 'Dev reviewed: this describes the change accurately, in plain English';
const DRAFT_NOTE_PREFIX = '_Draft built from commit messages';

const labelNames = (issue) => (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

/**
 * The window a release covers starts where the previous *authorized* one
 * did: the same "created before the release issue" cutoff that
 * authorize-deployment uses to close auto-filed issues.
 *
 * @param {Array<{ number: number, created_at: string, labels: Array }>} productionIssues
 * @param {{ number: number, created_at: string }} release - the current release issue
 * @returns {{ number: number, created_at: string } | null} the most recent
 *   earlier release labeled ready-for-deploy, or null if this is the first
 */
function findPreviousAuthorizedRelease(productionIssues, release) {
  const cutoff = Date.parse(release.created_at);
  const earlier = (productionIssues || [])
    .filter((i) => i.number !== release.number && !i.pull_request)
    .filter((i) => labelNames(i).includes('ready-for-deploy'))
    .filter((i) => Date.parse(i.created_at) < cutoff)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return earlier[0] || null;
}

/**
 * @param {Array<{ number: number, created_at: string, state_reason?: string | null }>} qaIssues
 *   - qa-request issues, open and closed
 * @param {string | null} since - exclusive lower bound (previous release's created_at)
 * @param {string} until - inclusive upper bound (this release's created_at)
 * @returns {Array} in-window QA Requests, oldest first, skipping ones closed
 *   as not planned (e.g. filed for a PR that was closed unmerged)
 */
function selectQaRequestsInWindow(qaIssues, since, until) {
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = Date.parse(until);
  return (qaIssues || [])
    .filter((i) => !i.pull_request)
    .filter((i) => i.state_reason !== 'not_planned')
    .filter((i) => {
      const t = Date.parse(i.created_at);
      return t > lo && t <= hi;
    })
    .sort((a, b) => a.number - b.number);
}

/**
 * @param {string} body - a QA Request body
 * @returns {number | null} the PR it was auto-filed for, if any
 */
function parseOriginPrNumber(body) {
  const match = (body || '').match(/origin: PR #(\d+)(?!\d)/);
  return match ? parseInt(match[1], 10) : null;
}

function section(body, heading) {
  const lines = (body || '').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l) || l.trim() === '---');
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * @param {string} body - a QA Request body
 * @returns {{ bullets: string[], couldAffect: string[], isDraft: boolean,
 *   missing: boolean }} the "What Changed (plain English)" notes, with any
 *   "Could affect:" lines pulled out so the roll-up can merge them
 */
function extractWhatChanged(body) {
  const text = section(body, '### What Changed (plain English)');
  const result = { bullets: [], couldAffect: [], isDraft: false, missing: true };
  if (!text || text === '_No response_') return result;

  result.missing = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(DRAFT_NOTE_PREFIX)) {
      result.isDraft = true;
      continue;
    }
    const affect = line.match(/^(?:[-*]\s*)?could affect:\s*(.*)$/i);
    if (affect) {
      for (const area of affect[1].split(/[,;]/)) {
        const a = area.trim().replace(/\.$/, '');
        if (a) result.couldAffect.push(a);
      }
      continue;
    }
    result.bullets.push(/^[-*]\s/.test(line) ? `- ${line.slice(2).trim()}` : `- ${line}`);
  }
  if (!result.bullets.length && !result.couldAffect.length) result.missing = true;
  return result;
}

/**
 * @param {string} body
 * @returns {boolean} whether the dev ticked the Changelog Review box
 */
function isReviewed(body) {
  return (body || '').split('\n').some((l) => /^\s*- \[[xX]\] /.test(l) && l.includes(REVIEW_BOX));
}

/**
 * @param {string} body
 * @returns {string} Pass / Fail / Pending (or whatever the field says)
 */
function extractQaOutcome(body) {
  const text = section(body, '### QA Outcome');
  return text && text !== '_No response_' ? text.split('\n')[0].trim() : 'Pending';
}

/**
 * @param {{
 *   qaRequests: Array<{ number: number, title: string, state: string, body: string }>,
 *   unmerged: Array<{ number: number, prNumber: number }>,
 *   previousRelease: { number: number, created_at: string } | null,
 * }} params - qaRequests already exclude `unmerged`
 * @returns {string} the roll-up comment body (starts with ROLLUP_MARKER)
 */
function buildRollupComment({ qaRequests, unmerged, previousRelease }) {
  const scope = previousRelease
    ? `QA Requests filed since the last authorized release (#${previousRelease.number}, opened ${previousRelease.created_at.slice(0, 10)})`
    : 'all QA Requests filed before this release (no earlier authorized release found)';

  const out = [
    ROLLUP_MARKER,
    "## 📋 What's in this release",
    '',
    `_Collected from ${scope}. A best guess for information only; it doesn't block approval. Refresh it with \`gh workflow run notify-release-approver.yml -f release_issue=<N>\`._`,
    '',
  ];

  if (!qaRequests.length) {
    out.push('No QA Requests found in that window. If this release does contain changes, their QA Requests may be missing.');
  }

  const couldAffect = [];
  const unreviewed = [];
  for (const qa of qaRequests.slice(0, MAX_ITEMS)) {
    const wc = extractWhatChanged(qa.body);
    const reviewed = !wc.missing && isReviewed(qa.body);
    const outcome = extractQaOutcome(qa.body);
    const title = (qa.title || '').replace(/^QA REQUEST\s*-\s*/i, '');

    let status = '✅';
    let note = '';
    if (wc.missing) {
      status = '⚠️';
      note = ': no What Changed notes, see the QA Request';
    } else if (!reviewed) {
      status = '⚠️';
      note = wc.isDraft ? ': not reviewed by dev (still the auto-generated draft)' : ': not reviewed by dev';
    }
    if (status === '⚠️') unreviewed.push(qa.number);

    out.push(`### ${status} #${qa.number} ${title}${note}`);
    out.push(`_QA: ${outcome}${qa.state === 'closed' ? ' · closed' : ''}_`);
    out.push('');
    if (wc.bullets.length) out.push(...wc.bullets, '');
    for (const a of wc.couldAffect) {
      if (!couldAffect.some((c) => c.toLowerCase() === a.toLowerCase())) couldAffect.push(a);
    }
  }
  if (qaRequests.length > MAX_ITEMS) {
    const rest = qaRequests.slice(MAX_ITEMS).map((q) => `#${q.number}`);
    out.push(`…and ${rest.length} more: ${rest.join(', ')}`, '');
  }

  if (couldAffect.length) out.push(`**Could affect:** ${couldAffect.join(', ')}`, '');

  if (qaRequests.length) {
    const shown = Math.min(qaRequests.length, MAX_ITEMS);
    const reviewedCount = shown - unreviewed.length;
    out.push(
      unreviewed.length
        ? `**${reviewedCount} of ${shown} changelogs dev-reviewed.** Not yet reviewed: ${unreviewed.map((n) => `#${n}`).join(', ')}`
        : `**All ${shown} changelogs dev-reviewed.**`
    );
  }

  if ((unmerged || []).length) {
    out.push('', `Not included, PR not merged yet: ${unmerged.map((u) => `#${u.number} (PR #${u.prNumber})`).join(', ')}`);
  }

  return out.join('\n').trimEnd();
}

module.exports = {
  ROLLUP_MARKER,
  REVIEW_BOX,
  DRAFT_NOTE_PREFIX,
  findPreviousAuthorizedRelease,
  selectQaRequestsInWindow,
  parseOriginPrNumber,
  extractWhatChanged,
  isReviewed,
  extractQaOutcome,
  buildRollupComment,
};
