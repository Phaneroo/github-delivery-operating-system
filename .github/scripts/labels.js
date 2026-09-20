'use strict';

const fs = require('fs');
const path = require('path');

// Single source of truth for every label this package creates is
// labels.tsv, sitting next to this file — plain tab-separated text, not
// JS/JSON, so scripts/install.sh (a bash script) can read it directly with
// a `read` loop and no runtime dependency beyond bash itself. This file is
// only the JS-side parser, used by setup-labels.yml (once installed into a
// consumer repo) and src/install.js.
//
// Each line: name<TAB>color<TAB>description — description is optional (a
// line may have only two fields). Returned entries: [name, color,
// description?]. Invariant a future edit to labels.tsv must preserve: no
// field ever contains a literal tab, and no line ever has more than 3
// tab-separated fields — this parser (destructuring the split result) and
// scripts/install.sh's `read -r name color desc` diverge on either
// violation (JS drops fields past the 3rd; bash's `read` folds any overflow,
// including a literal tab, into $desc), silently reintroducing the exact
// per-consumer inconsistency this file exists to eliminate.
function readLabels(scriptsDir) {
  const text = fs.readFileSync(path.join(scriptsDir, 'labels.tsv'), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

module.exports = { readLabels };
