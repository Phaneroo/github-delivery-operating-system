#!/usr/bin/env node
'use strict';

const { run } = require('./harness');

console.log('github-delivery-os — test suite');
console.log('');

require('./install.test.js');
require('./fetch-latest-version.test.js');
require('./authorize-deployment-verdict.test.js');
require('./sprint-child-creator.test.js');
require('./auto-close-sprint.test.js');
require('./auto-qa-request.test.js');

run();
