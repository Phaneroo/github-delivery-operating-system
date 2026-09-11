'use strict';

const assert = require('assert/strict');
const { test } = require('./harness');
const { parseFeatures, buildChildBody } = require('../.github/scripts/sprint-child-creator');

// Approximates what GitHub actually renders for the sprint_planning.yml
// issue form (each field becomes a "### Label" heading followed by the
// answer), so the parser is exercised against realistic input, not just a
// hand-trimmed fragment.
function renderedFormBody(featuresBlock) {
  return [
    '### Sprint Name',
    '',
    'Sprint 12 - March 1–14',
    '',
    '### Sprint Start',
    '',
    '2026-03-07',
    '',
    '### Sprint End',
    '',
    '2026-03-21',
    '',
    '### Sprint Goal',
    '',
    'Ship burn-down improvements',
    '',
    '### Sprint Features (One Per Line)',
    '',
    featuresBlock,
    '',
    '### Sprint Approved',
    '',
    'Pending',
  ].join('\n');
}

test('parseFeatures extracts each line from a realistic rendered form body', () => {
  const body = renderedFormBody(
    ['Implement burn-down chart', 'Add sprint health indicator', 'Prevent duplicate child creation'].join('\n')
  );
  assert.deepEqual(parseFeatures(body), [
    'Implement burn-down chart',
    'Add sprint health indicator',
    'Prevent duplicate child creation',
  ]);
});

test('parseFeatures returns [] when there is no Sprint Features section', () => {
  assert.deepEqual(parseFeatures('### Sprint Name\n\nSprint 12'), []);
});

test('parseFeatures returns [] for an empty body', () => {
  assert.deepEqual(parseFeatures(''), []);
  assert.deepEqual(parseFeatures(undefined), []);
});

test('parseFeatures returns [] when the section has no non-blank lines', () => {
  assert.deepEqual(parseFeatures(renderedFormBody('')), []);
});

test('parseFeatures ignores blank lines between features', () => {
  const body = renderedFormBody('Feature one\n\n\nFeature two\n\nFeature three');
  assert.deepEqual(parseFeatures(body), ['Feature one', 'Feature two', 'Feature three']);
});

test('parseFeatures trims surrounding whitespace on each line', () => {
  const body = renderedFormBody('  Feature with leading spaces  \nAnother feature\t');
  assert.deepEqual(parseFeatures(body), ['Feature with leading spaces', 'Another feature']);
});

test('parseFeatures stops at the next heading and does not leak later fields', () => {
  const body = renderedFormBody('Only feature');
  const features = parseFeatures(body);
  assert.equal(features.includes('Pending'), false, 'must not pick up the Sprint Approved answer');
  assert.deepEqual(features, ['Only feature']);
});

test('parseFeatures works when the Features section is the last thing in the body', () => {
  const body = '### Sprint Features (One Per Line)\n\nLast feature in the body';
  assert.deepEqual(parseFeatures(body), ['Last feature in the body']);
});

test('buildChildBody references the parent sprint number', () => {
  const result = buildChildBody(42);
  assert.match(result, /Parent Sprint: #42/);
});
