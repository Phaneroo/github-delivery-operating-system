'use strict';

// Pure verdict-computation logic for authorize-deployment.yml, extracted out
// of the inline actions/github-script step so it can be unit tested directly
// (see test/authorize-deployment-verdict.test.js) instead of only verified
// by hand whenever it changes. Has no dependency on the `github`/`context`
// globals actions/github-script injects — everything it needs is passed in.

// Anchored to comment start + word boundary so keywords must lead the
// comment (matches the documented convention) and can't match inside a
// larger word (e.g. "ok" no longer matches "okay", "reject" no longer
// matches "rejection") or as a substring anywhere in unrelated prose.
const DECLINE_RE = /^(declined|rejected|reject|not approved)\b/i;
const APPROVE_RE = /^(approved|approve|ok|go ahead)\b/i;
const QA_APPROVE_RE = /^(qa approved|approved|qa ok|looks good)\b/i;

const normalize = (s) => (s || '').toLowerCase();

/**
 * Walks comments in chronological order and keeps the LATEST verdict from
 * each approver, rather than stopping at the first decline seen. This lets a
 * release approver re-approve after an earlier decline (e.g. once fixes
 * land) instead of being permanently stuck as declined.
 *
 * @param {Array<{ user?: { login?: string | null } | null, body?: string | null }>} comments
 *   Chronological (oldest first), matching the order github.paginate(listComments) returns.
 * @param {string} releaseApprover
 * @param {string} qaApprover
 * @returns {{ releaseVerdict: 'approved' | 'declined' | null, qaApproved: boolean }}
 */
function computeVerdict(comments, releaseApprover, qaApprover) {
  let releaseVerdict = null;
  let qaApproved = false;

  for (const comment of comments) {
    const login = comment.user && comment.user.login;
    const body = (comment.body || '').trim();

    if (normalize(login) === normalize(releaseApprover)) {
      if (DECLINE_RE.test(body)) {
        releaseVerdict = 'declined';
      } else if (APPROVE_RE.test(body)) {
        releaseVerdict = 'approved';
      }
    }

    if (normalize(login) === normalize(qaApprover) && QA_APPROVE_RE.test(body)) {
      qaApproved = true;
    }
  }

  return { releaseVerdict, qaApproved };
}

// Footers auto-qa-request.js writes on what it files (buildAutoTaskBody /
// buildQaRequestBody). Matched here instead of imported so this workflow
// only ever needs its own script installed; test/authorize-deployment-
// verdict.test.js builds real bodies with auto-qa-request.js to catch drift.
const AUTO_QA_FOOTERS = [
  '*Auto-filed by Delivery OS (no issue was linked when this work reached main)*',
  '*Auto-filed by Delivery OS — origin: ',
];

/**
 * Once a release is authorized, the Tasks / QA Requests auto-qa-request
 * filed for work already on `main` are covered by that sign-off. Selects
 * those — and only those: never an issue a person (or the delivery-ops
 * skill's own tracking) filed, and never one filed after the release was
 * requested, since that work may not be in it.
 *
 * @param {Array<{ number: number, body: string, created_at: string,
 *   pull_request?: object }>} openIssues - open issues labeled delivery-ops-filed
 * @param {string} releaseRequestedAt - the production issue's created_at
 * @returns {number[]}
 */
function selectFilingsToCloseOnRelease(openIssues, releaseRequestedAt) {
  const cutoff = Date.parse(releaseRequestedAt);
  return (openIssues || [])
    .filter((issue) => !issue.pull_request)
    .filter((issue) => AUTO_QA_FOOTERS.some((f) => (issue.body || '').includes(f)))
    .filter((issue) => Date.parse(issue.created_at) <= cutoff)
    .map((issue) => issue.number);
}

/**
 * A filing made for a PR only belongs to a release once that PR has merged;
 * the workflow checks each PR this returns before closing its filings.
 *
 * @param {string} body - an auto-filed Task or QA Request body
 * @returns {number | null} the PR it was filed for, or null for a direct push
 */
function parseFilingPrNumber(body) {
  const match = (body || '').match(/origin: PR #(\d+)(?!\d)|Opened as PR #(\d+) \(/);
  return match ? parseInt(match[1] || match[2], 10) : null;
}

module.exports = { computeVerdict, selectFilingsToCloseOnRelease, parseFilingPrNumber, DECLINE_RE, APPROVE_RE, QA_APPROVE_RE };
