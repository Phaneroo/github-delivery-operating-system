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
// description?].
function readLabels(scriptsDir) {
  const text = fs.readFileSync(path.join(scriptsDir, 'labels.tsv'), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

module.exports = { readLabels };
