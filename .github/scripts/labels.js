'use strict';

// Single source of truth for every label this package creates. Consumed by:
//  - .github/workflows/setup-labels.yml (requires this file after checkout,
//    from a CONSUMER repo's own .github/scripts/ once installed there)
//  - src/install.js (`npx github-delivery-os install --with-labels`)
//  - scripts/install.sh (via a `node -e` one-liner, since it's plain bash)
// Each entry: [name, color, description?] — description is optional.
const LABELS = [
  ['intake', '0E8A16'],
  ['bug', 'D93F0B'],
  ['sprint', '1D76DB'],
  [
    'sprint-child',
    '1D76DB',
    "Applied to a sprint's task-breakdown children on open; doesn't change when the sprint closes",
  ],
  ['planning', '5319E7'],
  ['sprint-planning', '5319E7'],
  ['task', '7057FF'],
  ['qa', 'FBCA04'],
  ['qa-request', 'FBCA04'],
  ['production', 'D93F0B'],
  ['release', 'B60205'],
  ['approval', '0E8A16'],
  ['ready-for-deploy', '0E8A16'],
  ['declined', 'B60205'],
  ['risk', 'B60205'],
];

module.exports = { LABELS };
