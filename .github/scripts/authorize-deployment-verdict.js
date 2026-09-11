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

module.exports = { computeVerdict, DECLINE_RE, APPROVE_RE, QA_APPROVE_RE };
