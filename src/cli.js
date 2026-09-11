#!/usr/bin/env node

const { program } = require('commander');
const path = require('path');
const fs = require('fs');
const { runInstall, runStatus, runUninstall } = require('./install');

const pkgPath = path.join(__dirname, '..', 'package.json');
const version = fs.existsSync(pkgPath)
  ? require(pkgPath).version
  : '1.0.0';

program
  .name('delivery-os')
  .description('GitHub Delivery Operating System — structured sprint execution, QA review, and production release control')
  .version(version);

program
  .command('install [target]')
  .description('Install workflows and templates into a repository')
  .option('-t, --with-templates', 'Copy issue templates (sprint, task, bug, QA, production release)')
  .option('-l, --with-labels', 'Create labels via gh CLI (requires gh auth)')
  .option('-o, --overwrite', 'Replace existing workflow/template files')
  .option('--no-overwrite', 'Skip existing files (default)')
  .option('-d, --dry-run', 'Show what would happen without changing files')
  .action((target, options) => {
    const targetDir = target || '.';
    runInstall({
      targetDir,
      withTemplates: options.withTemplates ?? false,
      withLabels: options.withLabels ?? false,
      overwrite: options.overwrite ?? false,
      dryRun: options.dryRun ?? false,
    });
  });

program
  .command('status [target]')
  .description('Show which workflows and templates are installed')
  .option('--offline', 'Skip checking npm for the latest published version')
  .action(async (target, options) => {
    await runStatus({ targetDir: target || '.', checkUpdates: !options.offline });
  });

program
  .command('uninstall [target]')
  .description('Remove Delivery OS workflows (and optionally templates)')
  .option('-t, --with-templates', 'Also remove issue templates')
  .option('-d, --dry-run', 'Show what would be removed without deleting')
  .action((target, options) => {
    runUninstall({
      targetDir: target || '.',
      withTemplates: options.withTemplates ?? false,
      dryRun: options.dryRun ?? false,
    });
  });

program.parse();

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
