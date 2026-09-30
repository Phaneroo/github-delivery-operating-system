'use strict';

// Pure burn-down/health computation for auto-close-sprint.yml, extracted so
// it can be unit tested directly (see test/auto-close-sprint.test.js)
// instead of only verified by hand.

/**
 * @param {string} body - a child issue's body
 * @returns {number | null} the parent sprint issue number, or null if this
 *   issue isn't a sprint child (no "Parent Sprint: #N" line).
 */
function parseParentSprintNumber(body) {
  const match = (body || '').match(/Parent Sprint:\s*#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Whether an issue is a child of sprint `sprintNumber`. Compares the parsed
 * number, not a substring: "Parent Sprint: #57" must not count as a child of
 * sprint #5. Pull requests are never children.
 *
 * @param {{ body?: string | null, pull_request?: object }} issue
 * @param {number} sprintNumber
 * @returns {boolean}
 */
function isSprintChild(issue, sprintNumber) {
  if (!issue || issue.pull_request) return false;
  return parseParentSprintNumber(issue.body) === sprintNumber;
}

/**
 * Parses sprint dates out of a sprint issue's body, supporting both the
 * combined "Sprint Dates: X to Y" format and the separate "Sprint Start" /
 * "Sprint End" field format (the sprint_planning.yml template).
 *
 * @param {string} sprintBody - the sprint (parent) issue's body
 * @returns {{ startDate: Date, endDate: Date } | null} null if neither
 *   format matched.
 */
function parseSprintDates(sprintBody) {
  const body = sprintBody || '';

  const rangeMatch = body.match(/Sprint Dates[\s\S]*?(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/i);
  if (rangeMatch) {
    return { startDate: new Date(rangeMatch[1]), endDate: new Date(rangeMatch[2]) };
  }

  const startMatch = body.match(/Sprint Start[\s\S]*?(\d{4}-\d{2}-\d{2})/i);
  const endMatch = body.match(/Sprint End[\s\S]*?(\d{4}-\d{2}-\d{2})/i);
  if (startMatch && endMatch) {
    return { startDate: new Date(startMatch[1]), endDate: new Date(endMatch[1]) };
  }

  return null;
}

/**
 * @param {Date} startDate
 * @param {Date} endDate
 * @param {Date} now
 * @returns {number} percent of the sprint's duration elapsed as of `now`,
 *   clamped to [0, 100]. Returns 100 for a zero-or-negative-length sprint
 *   (Start >= End — a data-entry mistake) or an unparseable date (e.g. an
 *   out-of-range "2026-13-05" typo, which regex-matches the YYYY-MM-DD
 *   shape but produces an Invalid Date) instead of dividing by zero or NaN:
 *   that NaN would otherwise flow into the posted burn-down as "Time
 *   Elapsed: NaN%", and every NaN comparison in computeHealthEmoji is
 *   false, so it'd silently default to the green/no-warning branch instead
 *   of flagging the broken dates. `!(totalDuration > 0)` (rather than
 *   `totalDuration <= 0`) catches NaN too, since every comparison against
 *   NaN is false — `NaN <= 0` is false, but so is `NaN > 0`, and negating
 *   that is true.
 */
function computeTimePercent(startDate, endDate, now) {
  const totalDuration = endDate - startDate;
  if (!(totalDuration > 0)) return 100;
  const elapsed = now - startDate;
  return Math.max(0, Math.min(100, Math.round((elapsed / totalDuration) * 100)));
}

/**
 * Work that was dropped (closed as "not planned") leaves the sprint's count
 * entirely, so abandoning a task neither inflates progress nor blocks the
 * sprint from finishing. If everything was dropped there is nothing left to
 * complete, so progress stays 0 and the sprint is not auto-closed.
 *
 * @param {Array<{ state: string, state_reason?: string | null }>} children
 * @returns {{ progressPercent: number, closedCount: number, totalCount: number }}
 */
function computeProgress(allChildren) {
  const children = allChildren.filter((i) => !(i.state === 'closed' && i.state_reason === 'not_planned'));
  const totalCount = children.length;
  const closedCount = children.filter((i) => i.state === 'closed').length;
  const progressPercent = totalCount === 0 ? 0 : Math.round((closedCount / totalCount) * 100);
  return { progressPercent, closedCount, totalCount };
}

/**
 * Sprint health relative to time elapsed: red if progress trails time by
 * more than 10 points, yellow if behind at all, green otherwise.
 *
 * @returns {'🟢' | '🟡' | '🔴'}
 */
function computeHealthEmoji(progressPercent, timePercent) {
  if (progressPercent < timePercent - 10) return '🔴';
  if (progressPercent < timePercent) return '🟡';
  return '🟢';
}

/**
 * @returns {string} a block-character progress bar, e.g. "████░░░░░░░░░░░░░░░░".
 */
function renderBurnDown(progressPercent, totalBars = 20) {
  const filledBars = Math.round((progressPercent / 100) * totalBars);
  return '█'.repeat(filledBars) + '░'.repeat(totalBars - filledBars);
}

// Posted when the last child closes and the sprint closes itself. It also
// marks a sprint as auto-closed, so a reopened child can reopen it (a sprint
// somebody closed by hand is left alone).
const AUTO_CLOSE_COMMENT = '🎉 All sprint tasks complete. Sprint automatically closed.';

// The sprint is closed, then the comment is posted a moment later.
const AUTO_CLOSE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Whether the sprint's CURRENT close is the automatic one: the completion
 * comment exists and was posted right when the sprint last closed. A sprint
 * that auto-closed, was reopened, and was then closed by hand still has the
 * old comment, but its latest close is not the automatic one.
 *
 * @param {Array<{ body?: string | null, created_at?: string }>} comments - the sprint issue's comments
 * @param {string | null} [closedAt] - when the sprint was last closed
 * @returns {boolean}
 */
function wasAutoClosed(comments, closedAt) {
  const marks = (comments || []).filter((c) => (c.body || '').trim() === AUTO_CLOSE_COMMENT);
  if (!marks.length) return false;
  if (!closedAt) return true; // can't tell when it closed: trust the comment
  const last = marks[marks.length - 1];
  const gap = Math.abs(Date.parse(closedAt) - Date.parse(last.created_at));
  return gap <= AUTO_CLOSE_WINDOW_MS;
}

/**
 * Replaces any previous "## 🚦 Sprint Status" block in the sprint body with
 * a freshly rendered one (appended at the end).
 */
function updateSprintBody(sprintBody, { progressPercent, timePercent, healthEmoji, burnDown }) {
  let updatedBody = (sprintBody || '').replace(/## 🚦 Sprint Status[\s\S]*?---/g, '');

  updatedBody +=
    `\n\n---\n\n## 🚦 Sprint Status\n\n` +
    `Progress: **${progressPercent}%**\n` +
    `Time Elapsed: **${timePercent}%**\n\n` +
    `Health: ${healthEmoji}\n\n` +
    `### 📉 Burn-down\n` +
    `\`${burnDown}\` ${progressPercent}%\n\n---`;

  return updatedBody;
}

module.exports = {
  parseParentSprintNumber,
  isSprintChild,
  AUTO_CLOSE_COMMENT,
  wasAutoClosed,
  parseSprintDates,
  computeTimePercent,
  computeProgress,
  computeHealthEmoji,
  renderBurnDown,
  updateSprintBody,
};
