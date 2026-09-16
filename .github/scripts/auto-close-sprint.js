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
 *   (Start >= End — a data-entry mistake) instead of dividing by zero: that
 *   NaN would otherwise flow into the posted burn-down as "Time Elapsed:
 *   NaN%", and every NaN comparison in computeHealthEmoji is false, so it'd
 *   silently default to the green/no-warning branch instead of flagging the
 *   broken dates.
 */
function computeTimePercent(startDate, endDate, now) {
  const totalDuration = endDate - startDate;
  if (totalDuration <= 0) return 100;
  const elapsed = now - startDate;
  return Math.max(0, Math.min(100, Math.round((elapsed / totalDuration) * 100)));
}

/**
 * @param {Array<{ state: string }>} children
 * @returns {{ progressPercent: number, closedCount: number, totalCount: number }}
 */
function computeProgress(children) {
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
  parseSprintDates,
  computeTimePercent,
  computeProgress,
  computeHealthEmoji,
  renderBurnDown,
  updateSprintBody,
};
