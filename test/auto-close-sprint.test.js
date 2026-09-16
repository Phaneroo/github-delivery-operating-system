'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const {
  parseParentSprintNumber,
  parseSprintDates,
  computeTimePercent,
  computeProgress,
  computeHealthEmoji,
  renderBurnDown,
  updateSprintBody,
} = require('../.github/scripts/auto-close-sprint');

// --- parseParentSprintNumber ---

test('parseParentSprintNumber extracts the number', () => {
  assert.equal(parseParentSprintNumber('Parent Sprint: #42\n\n---'), 42);
});

test('parseParentSprintNumber returns null when absent', () => {
  assert.equal(parseParentSprintNumber('Just a regular issue body'), null);
  assert.equal(parseParentSprintNumber(''), null);
  assert.equal(parseParentSprintNumber(undefined), null);
});

// --- parseSprintDates ---

test('parseSprintDates parses the "Sprint Dates: X to Y" combined format', () => {
  const result = parseSprintDates('### Sprint Dates\n\n2026-03-07 to 2026-03-21');
  assert.equal(result.startDate.toISOString().slice(0, 10), '2026-03-07');
  assert.equal(result.endDate.toISOString().slice(0, 10), '2026-03-21');
});

test('parseSprintDates parses the separate "Sprint Start" / "Sprint End" template format', () => {
  const body = '### Sprint Start\n\n2026-03-07\n\n### Sprint End\n\n2026-03-21';
  const result = parseSprintDates(body);
  assert.equal(result.startDate.toISOString().slice(0, 10), '2026-03-07');
  assert.equal(result.endDate.toISOString().slice(0, 10), '2026-03-21');
});

test('parseSprintDates prefers the combined format when both are present', () => {
  const body =
    '### Sprint Dates\n\n2026-01-01 to 2026-01-14\n\n### Sprint Start\n\n2099-01-01\n\n### Sprint End\n\n2099-01-14';
  const result = parseSprintDates(body);
  assert.equal(result.startDate.toISOString().slice(0, 10), '2026-01-01');
});

test('parseSprintDates returns null when neither format is present', () => {
  assert.equal(parseSprintDates('### Sprint Goal\n\nShip things'), null);
  assert.equal(parseSprintDates(''), null);
});

test('parseSprintDates returns null when only start (no end) is present', () => {
  assert.equal(parseSprintDates('### Sprint Start\n\n2026-03-07'), null);
});

// --- computeTimePercent ---

test('computeTimePercent is 0 at the start and 100 at the end', () => {
  const start = new Date('2026-01-01');
  const end = new Date('2026-01-11'); // 10 days
  assert.equal(computeTimePercent(start, end, start), 0);
  assert.equal(computeTimePercent(start, end, end), 100);
});

test('computeTimePercent is roughly linear mid-sprint', () => {
  const start = new Date('2026-01-01');
  const end = new Date('2026-01-11');
  const mid = new Date('2026-01-06'); // 5 of 10 days
  assert.equal(computeTimePercent(start, end, mid), 50);
});

test('computeTimePercent clamps below 0 and above 100', () => {
  const start = new Date('2026-01-01');
  const end = new Date('2026-01-11');
  assert.equal(computeTimePercent(start, end, new Date('2025-01-01')), 0, 'before the sprint starts');
  assert.equal(computeTimePercent(start, end, new Date('2027-01-01')), 100, 'well after the sprint ends');
});

test('computeTimePercent returns 100 instead of NaN when Start >= End (data-entry mistake)', () => {
  // Regression guard: dividing by a zero/negative totalDuration used to
  // produce NaN, which flowed into the posted burn-down as "Time Elapsed:
  // NaN%" — and every NaN comparison in computeHealthEmoji is false, so it
  // silently defaulted to the green/no-warning branch instead of flagging
  // the broken dates.
  const same = new Date('2026-01-01');
  assert.equal(computeTimePercent(same, same, same), 100, 'zero-length sprint');
  assert.equal(
    computeTimePercent(new Date('2026-01-05'), new Date('2026-01-01'), new Date('2026-01-03')),
    100,
    'End before Start'
  );
});

// --- computeProgress ---

test('computeProgress with no children is 0%', () => {
  assert.deepEqual(computeProgress([]), { progressPercent: 0, closedCount: 0, totalCount: 0 });
});

test('computeProgress counts closed vs total', () => {
  const children = [{ state: 'closed' }, { state: 'closed' }, { state: 'open' }, { state: 'open' }];
  assert.deepEqual(computeProgress(children), { progressPercent: 50, closedCount: 2, totalCount: 4 });
});

test('computeProgress at 100% when all children are closed', () => {
  const children = [{ state: 'closed' }, { state: 'closed' }];
  assert.equal(computeProgress(children).progressPercent, 100);
});

// --- computeHealthEmoji ---

test('computeHealthEmoji is green when on pace or ahead', () => {
  assert.equal(computeHealthEmoji(50, 50), '🟢');
  assert.equal(computeHealthEmoji(80, 50), '🟢');
});

test('computeHealthEmoji is yellow when slightly behind', () => {
  assert.equal(computeHealthEmoji(45, 50), '🟡');
});

test('computeHealthEmoji is red when more than 10 points behind', () => {
  assert.equal(computeHealthEmoji(30, 50), '🔴');
});

// --- renderBurnDown ---

test('renderBurnDown at 0% is all empty blocks', () => {
  assert.equal(renderBurnDown(0), '░'.repeat(20));
});

test('renderBurnDown at 100% is all filled blocks', () => {
  assert.equal(renderBurnDown(100), '█'.repeat(20));
});

test('renderBurnDown at 50% is half and half', () => {
  assert.equal(renderBurnDown(50), '█'.repeat(10) + '░'.repeat(10));
});

// --- updateSprintBody ---

test('updateSprintBody appends a Sprint Status section', () => {
  const result = updateSprintBody('### Sprint Goal\n\nShip things', {
    progressPercent: 50,
    timePercent: 40,
    healthEmoji: '🟢',
    burnDown: '██████████░░░░░░░░░░',
  });
  assert.match(result, /## 🚦 Sprint Status/);
  assert.match(result, /Progress: \*\*50%\*\*/);
  assert.match(result, /Time Elapsed: \*\*40%\*\*/);
  assert.match(result, /Health: 🟢/);
  assert.match(result, /Ship things/, 'must not discard the rest of the sprint body');
});

test('updateSprintBody replaces a previous Sprint Status section instead of stacking them', () => {
  const withOldStatus = updateSprintBody('### Sprint Goal\n\nShip things', {
    progressPercent: 20,
    timePercent: 20,
    healthEmoji: '🟢',
    burnDown: renderBurnDown(20),
  });
  const withNewStatus = updateSprintBody(withOldStatus, {
    progressPercent: 80,
    timePercent: 70,
    healthEmoji: '🟢',
    burnDown: renderBurnDown(80),
  });
  const statusSectionCount = (withNewStatus.match(/## 🚦 Sprint Status/g) || []).length;
  assert.equal(statusSectionCount, 1, 'must not accumulate multiple status sections across repeated updates');
  assert.match(withNewStatus, /Progress: \*\*80%\*\*/);
  assert.doesNotMatch(withNewStatus, /Progress: \*\*20%\*\*/, 'must not leave the stale progress figure behind');
});
