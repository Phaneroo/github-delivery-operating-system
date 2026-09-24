'use strict';

// Pure logic for the release roll-up posted by notify-release-approver.yml:
// one comment on a Production Release issue collecting the plain-English
// "What Changed" notes from every QA Request the release likely covers, so
// approvers can see what they're signing off. Informational only: nothing
// here blocks authorization. Unit tested in test/release-rollup.test.js.

// The rolling QA issue's checklist format is owned by auto-qa-request.js;
// read it through the same parser rather than a copy.
const { parseChanges } = require('./auto-qa-request');

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
 * A release covers QA Requests filed since the previous one, plus any older
 * request that's still open: authorizing a release closes the filings it
 * covered, so one still open (e.g. its PR merged only after that release)
 * hasn't shipped yet and belongs to this one.
 *
 * @param {Array<{ number: number, created_at: string, state: string,
 *   state_reason?: string | null }>} qaIssues - qa-request issues, open and closed
 * @param {string | null} since - exclusive lower bound (previous release's created_at)
 * @param {string} until - inclusive upper bound (this release's created_at)
 * @returns {Array} matching QA Requests, oldest first, skipping ones closed
 *   as not planned (e.g. filed for a PR that was closed unmerged)
 */
function selectQaRequestsInWindow(qaIssues, since, until) {
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = Date.parse(until);
  return (qaIssues || [])
    .filter((i) => !i.pull_request)
    .filter((i) => !labelNames(i).includes('qa-rollup')) // rolling issues: see selectRollingIssues
    .filter((i) => i.state_reason !== 'not_planned')
    .filter((i) => {
      const t = Date.parse(i.created_at);
      return t <= hi && (t > lo || i.state === 'open');
    })
    .sort((a, b) => a.number - b.number);
}

/**
 * Rolling QA issues a release covers: the open one (changes still awaiting
 * QA), plus any approved and closed since the previous release. Duplicates
 * folded into another (closed not planned) are skipped.
 *
 * @param {Array<{ number: number, state: string, state_reason?: string | null,
 *   created_at: string, closed_at?: string | null, labels: Array }>} issues
 * @param {string | null} since - previous authorized release's created_at
 * @param {string} until - this release's created_at
 * @returns {Array} oldest first
 */
function selectRollingIssues(issues, since, until) {
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = Date.parse(until);
  return (issues || [])
    .filter((i) => !i.pull_request && labelNames(i).includes('qa-rollup'))
    .filter((i) => i.state_reason !== 'not_planned')
    .filter((i) => Date.parse(i.created_at) <= hi)
    .filter((i) => i.state === 'open' || (i.closed_at && Date.parse(i.closed_at) > lo))
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
function buildRollupComment({ qaRequests, unmerged, previousRelease, rolling = [], releaseCreatedAt = null }) {
  const scope = previousRelease
    ? `QA Requests filed since the last authorized release (#${previousRelease.number}, opened ${previousRelease.created_at.slice(0, 10)}), plus older ones still open`
    : 'all QA Requests filed before this release (no earlier authorized release found)';

  const out = [
    ROLLUP_MARKER,
    "## 📋 What's in this release",
    '',
    `_Collected from ${scope}. A best guess for information only; it doesn't block approval. Refresh it with \`gh workflow run notify-release-approver.yml -f release_issue=<N>\`._`,
    '',
  ];

  const couldAffect = [];
  const addAffects = (areas) => {
    for (const a of areas) {
      if (!couldAffect.some((c) => c.toLowerCase() === a.toLowerCase())) couldAffect.push(a);
    }
  };

  // Rolling QA issues: one section each, one line per change.
  // Which of a rolling issue's lines belong to this release: added before it
  // was requested, and either added since the previous release or still
  // awaiting QA (an approved line from before then shipped in that one).
  // Lines without a timestamp (pre-1.9.0 test data) are always included.
  const lo = previousRelease ? Date.parse(previousRelease.created_at) : -Infinity;
  const hi = releaseCreatedAt ? Date.parse(releaseCreatedAt) : Infinity;
  let rollingChanges = 0;
  let rollingApproved = 0;
  for (const issue of rolling) {
    const outcome = extractQaOutcome(issue.body);
    const approved = issue.state === 'closed' && issue.state_reason === 'completed';
    const all = parseChanges(issue.body);
    const later = all.filter((c) => c.addedAt && Date.parse(c.addedAt) > hi).length;
    const changes = all.filter((c) => {
      if (!c.addedAt) return true;
      const t = Date.parse(c.addedAt);
      return t <= hi && (t > lo || !approved);
    });
    if (!changes.length && !later) continue;
    const status = approved
      ? '✅ QA approved'
      : outcome.toLowerCase() === 'fail'
        ? '❌ QA declined, fixes awaiting re-test'
        : '⚠️ awaiting QA approval';
    out.push(`### 🔄 Rolling QA #${issue.number}: ${status}`);
    out.push('');
    for (const change of changes) {
      const mark = approved || change.checked ? '✅' : '⏳';
      out.push(`- ${mark} ${change.text}`);
      for (const bullet of change.bullets) {
        const affect = bullet.match(/^[-*]\s*could affect:\s*(.*)$/i);
        if (affect) {
          addAffects(affect[1].split(/[,;]/).map((a) => a.trim().replace(/\.$/, '')).filter(Boolean));
        } else {
          out.push(`  ${bullet}`);
        }
      }
    }
    if (!changes.length) out.push('_No changes from before this release was requested._');
    if (later) out.push(`_${later} change(s) added after this release was requested aren't included._`);
    out.push('');
    rollingChanges += changes.length;
    if (approved) rollingApproved += changes.length;
  }

  if (!qaRequests.length && !rolling.length) {
    out.push('No QA Requests found in that window. If this release does contain changes, their QA Requests may be missing.');
  }

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
    addAffects(wc.couldAffect);
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

  if (rollingChanges) {
    out.push(`**Rolling QA:** ${rollingApproved} of ${rollingChanges} change(s) QA-approved.`);
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
  selectRollingIssues,
  parseOriginPrNumber,
  extractWhatChanged,
  isReviewed,
  extractQaOutcome,
  buildRollupComment,
};
