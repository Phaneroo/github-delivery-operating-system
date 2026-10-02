#!/usr/bin/env node

const { program, Option } = require('commander');
const path = require('path');
const fs = require('fs');
const { runInstall, runStatus, runUninstall, runList, runAdd, runRemove } = require('./install');
const { runShellHook } = require('./shell-hook');
const { runSetupSkill } = require('./setup-skill');

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
  .option('-s, --with-skill', 'Add the delivery-ops Claude Code skill (.claude/skills/delivery-ops/SKILL.md)')
  .option('-u, --update', 'Replace existing workflow/template files with the latest version')
  .option('--no-update', 'Skip existing files (default)')
  // Pre-1.5.0 names, kept working silently so existing scripts/CI calling
  // `install --overwrite` don't break — --update is the documented name now.
  .addOption(new Option('-o, --overwrite').hideHelp())
  .addOption(new Option('--no-overwrite').hideHelp())
  .addOption(
    new Option('-b, --bundle <name>', 'Which set to install: full (everything) or lite (sprints, tasks, bugs and a release approval, without the QA machinery). Defaults to the repo\'s current bundle, or full.').choices(['full', 'lite'])
  )
  .option('--only <workflows>', 'Install just these workflows (comma-separated names; see `list`)')
  .option('--skip <workflows>', 'Install the bundle without these workflows (comma-separated names; see `list`)')
  .option('--set-approvers', 'Set the RELEASE_APPROVER repo variable to your GitHub login via gh (never overwrites an existing value). On by default for --bundle lite')
  .option('--no-set-approvers', 'Do not set the approver variable')
  .option('-d, --dry-run', 'Show what would happen without changing files')
  .action((target, options) => {
    const targetDir = target || '.';
    runInstall({
      targetDir,
      withTemplates: options.withTemplates ?? false,
      withLabels: options.withLabels ?? false,
      withSkill: options.withSkill ?? false,
      overwrite: options.update ?? options.overwrite ?? false,
      dryRun: options.dryRun ?? false,
      bundle: options.bundle,
      setApprovers: options.setApprovers,
      only: options.only,
      skip: options.skip,
    });
  });

program
  .command('add <names> [target]')
  .description('Add packs (qa, telegram) or single workflows (comma-separated) to what is installed; see `list`')
  .option('-l, --with-labels', 'Create labels via gh CLI (requires gh auth)')
  .option('-d, --dry-run', 'Show what would happen without changing files')
  .action((names, target, options) => {
    runAdd({ targetDir: target || '.', names, withLabels: options.withLabels ?? false, dryRun: options.dryRun ?? false });
  });

program
  .command('remove <names> [target]')
  .description('Remove packs or single workflows (comma-separated), deleting the files only they need')
  .option('-d, --dry-run', 'Show what would be removed without deleting')
  .action((names, target, options) => {
    runRemove({ targetDir: target || '.', names, dryRun: options.dryRun ?? false });
  });

program
  .command('list [target]')
  .description('List the bundles, packs and workflows you can install, and which are installed in the repo (use --json for tools)')
  .option('--json', 'Machine-readable output')
  .action((target, options) => {
    runList({ json: options.json ?? false, targetDir: target || '.' });
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
  .option('-s, --with-skill', 'Also remove the delivery-ops Claude Code skill')
  .option('-d, --dry-run', 'Show what would be removed without deleting')
  .action((target, options) => {
    runUninstall({
      targetDir: target || '.',
      withTemplates: options.withTemplates ?? false,
      withSkill: options.withSkill ?? false,
      dryRun: options.dryRun ?? false,
    });
  });

program
  .command('setup-skill')
  .description('Add the Claude Code skill that helps you choose what to install (your ~/.claude/skills by default, so it works before any install)')
  .option('--project', 'Add it to this repo\'s .claude/skills instead of your user-level skills')
  .option('-u, --update', 'Replace an existing copy with this version')
  .option('-d, --dry-run', 'Show what would happen without changing files')
  .action((options) => {
    runSetupSkill({ project: options.project ?? false, update: options.update ?? false, dryRun: options.dryRun ?? false });
  });

program
  .command('shell-hook [shell]')
  .description('Remind you in the terminal when a repo\'s Delivery OS install is out of date (zsh or bash)')
  .option('--install', 'Add the reminder to your shell startup file (~/.zshrc, or ~/.bashrc / ~/.bash_profile on macOS)')
  .option('--uninstall', 'Remove it from your shell startup file')
  .action((shell, options) => {
    runShellHook({ shell, install: options.install ?? false, uninstall: options.uninstall ?? false });
  });

// parseAsync (not parse) because the `status` action is async — with plain
// parse(), an error thrown inside it becomes an unhandled rejection that
// Node <15 does not treat as fatal, so a real failure could exit 0.
program.parseAsync().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
