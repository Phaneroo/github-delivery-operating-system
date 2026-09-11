#!/usr/bin/env node
'use strict';

const { run } = require('./harness');

console.log('github-delivery-os — test suite');
console.log('');

require('./install.test.js');
require('./fetch-latest-version.test.js');

run();
