'use strict';

// Pure parsing logic for sprint-child-creator.yml, extracted so it can be
// unit tested directly (see test/sprint-child-creator.test.js) instead of
// only verified by hand.

/**
 * Extracts the feature list from a sprint-planning issue body's
 * "### Sprint Features" section (one feature per line, up to the next
 * heading or end of body).
 *
 * @param {string} body - the sprint issue's body
 * @returns {string[]} feature titles, in the order they appear. Empty if
 *   there's no Sprint Features section, or it has no non-blank lines.
 */
function parseFeatures(body) {
  const featuresMatch = (body || '').match(/### Sprint Features[\s\S]*?(?=###|$)/);
  if (!featuresMatch) return [];

  return featuresMatch[0]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('###'));
}

/**
 * @param {number} parentNumber - the sprint (parent) issue number
 * @returns {string} body to use for each generated child issue
 */
function buildChildBody(parentNumber) {
  return `Parent Sprint: #${parentNumber}\n\n---\n*Created by Delivery OS Sprint Child Creator*`;
}

module.exports = { parseFeatures, buildChildBody };
