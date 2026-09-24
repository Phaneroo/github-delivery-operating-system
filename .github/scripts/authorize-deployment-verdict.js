'use strict';

// Pure verdict-computation logic for authorize-deployment.yml, extracted out
// of the inline actions/github-script step so it can be unit tested directly
// (see test/authorize-deployment-verdict.test.js) instead of only verified
// by hand whenever it changes. Has no dependency on the `github`/`context`
// globals actions/github-script injects — everything it needs is passed in.

// ---------------------------------------------------------------------------
// Shared verdict matching. Every approve/decline keyword list in Delivery OS
// goes through phraseRegex/matchVerdict, so the rules can't drift between
// the release gate below and the rolling QA issue (qa-rollup-approval.yml):
//   - a phrase must START the comment (anything may follow) and end on a
//     word boundary: "ok" doesn't match "okay", "reject" not "rejection"
//   - whitespace between words is flexible ("not  approved")
//   - decline is checked BEFORE approve, so "not approved" / "not ok" can
//     never be read as "approved" / "ok"
// The lists differ per gate on purpose: the release gate keeps its original,
// stricter vocabulary; the rolling QA issue accepts a wider, friendlier one.
// ---------------------------------------------------------------------------

/**
 * @param {string[]} phrases
 * @returns {RegExp} matches when a comment starts with any of the phrases
 */
function phraseRegex(phrases) {
  const alternatives = phrases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((p) => p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(`^(?:${alternatives.join('|')})\\b`, 'i');
}

/**
 * @param {string} text - a comment body
 * @param {{ approve: RegExp, decline: RegExp, approveEmoji?: string[], declineEmoji?: string[] }} vocab
 * @returns {'approved' | 'declined' | null}
 */
function matchVerdict(text, vocab) {
  const t = (text || '').trim();
  const startsWithAny = (emojis) => (emojis || []).some((e) => t.startsWith(e));
  if (vocab.decline.test(t) || startsWithAny(vocab.declineEmoji)) return 'declined';
  if (vocab.approve.test(t) || startsWithAny(vocab.approveEmoji)) return 'approved';
  return null;
}

// Release gate (authorize-deployment): original vocabulary, unchanged.
const RELEASE_DECLINE_PHRASES = ['declined', 'rejected', 'reject', 'not approved'];
const RELEASE_APPROVE_PHRASES = ['approved', 'approve', 'ok', 'go ahead'];
const RELEASE_QA_APPROVE_PHRASES = ['qa approved', 'approved', 'qa ok', 'looks good'];
const DECLINE_RE = phraseRegex(RELEASE_DECLINE_PHRASES);
const APPROVE_RE = phraseRegex(RELEASE_APPROVE_PHRASES);
const QA_APPROVE_RE = phraseRegex(RELEASE_QA_APPROVE_PHRASES);

// Rolling QA issue (qa-rollup-approval): QA_APPROVER only. GitHub Actions
// can't trigger on emoji *reactions*, so an emoji must start a comment.
const ROLLING_QA_APPROVE_PHRASES = [
  'qa approved', 'approved', 'approve', 'qa ok', 'ok', 'looks good', 'lgtm',
  'all good', 'tested', 'passed', 'good to go', 'ship it',
];
const ROLLING_QA_DECLINE_PHRASES = [
  'not approved', 'declined', 'decline', 'rejected', 'reject', 'failed',
  'changes needed', 'needs work', 'not ok', 'blocked',
];
const ROLLING_QA_APPROVE_EMOJI = ['✅', '👍', '✔️', '✔'];
const ROLLING_QA_DECLINE_EMOJI = ['❌', '👎', '🚫'];
const ROLLING_QA_VOCAB = {
  approve: phraseRegex(ROLLING_QA_APPROVE_PHRASES),
  decline: phraseRegex(ROLLING_QA_DECLINE_PHRASES),
  approveEmoji: ROLLING_QA_APPROVE_EMOJI,
  declineEmoji: ROLLING_QA_DECLINE_EMOJI,
};

/**
 * @param {string} text - a comment on the rolling QA issue
 * @returns {'approved' | 'declined' | null}
 */
function matchRollingQaVerdict(text) {
  return matchVerdict(text, ROLLING_QA_VOCAB);
}

/**
 * What the rolling QA issue should do in response to the approver's latest
 * verdict. Every approver action is handled as it arrives, so "the latest
 * verdict wins" falls out of applying these in order.
 *
 * @param {{ state: 'open' | 'closed', verdict: 'approved' | 'declined',
 *   anotherRollingOpen: boolean }} params
 * @returns {'close' | 'already-closed' | 'ack-decline' | 'reopen-declined' | 'redirect'}
 */
function nextRollingQaAction({ state, verdict, anotherRollingOpen }) {
  if (verdict === 'approved') return state === 'open' ? 'close' : 'already-closed';
  if (state === 'open') return 'ack-decline';
  // Declined after it was approved: reopen it — unless a newer rolling issue
  // has already started, in which case the decline belongs over there.
  return anotherRollingOpen ? 'redirect' : 'reopen-declined';
}

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
      const verdict = matchVerdict(body, { approve: APPROVE_RE, decline: DECLINE_RE });
      if (verdict) releaseVerdict = verdict;
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

module.exports = {
  phraseRegex,
  matchVerdict,
  matchRollingQaVerdict,
  nextRollingQaAction,
  RELEASE_DECLINE_PHRASES,
  RELEASE_APPROVE_PHRASES,
  RELEASE_QA_APPROVE_PHRASES,
  ROLLING_QA_APPROVE_PHRASES,
  ROLLING_QA_DECLINE_PHRASES,
  ROLLING_QA_APPROVE_EMOJI,
  ROLLING_QA_DECLINE_EMOJI,
  computeVerdict, selectFilingsToCloseOnRelease, parseFilingPrNumber, DECLINE_RE, APPROVE_RE, QA_APPROVE_RE };
