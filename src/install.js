const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const MANIFEST_FILE = 'delivery-os.json'; // written to .github/delivery-os.json in the target repo
const SKILL_REL_PATH = path.join('.claude', 'skills', 'delivery-ops', 'SKILL.md'); // opt-in via --with-skill

const WORKFLOWS = [
  'sprint-child-creator',
  'auto-close-sprint',
  'notify-release-approver',
  'authorize-deployment',
  'auto-assign-qa',
  'telegram-issues',
  'setup-labels',
];

const LABELS = [
  ['intake', '0E8A16'],
  ['bug', 'D93F0B'],
  ['sprint', '1D76DB'],
  ['sprint-active', '1D76DB'],
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

function manifestPath(targetAbs) {
  return path.join(targetAbs, '.github', MANIFEST_FILE);
}

function skillPath(targetAbs) {
  return path.join(targetAbs, SKILL_REL_PATH);
}

function readManifest(targetAbs) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(targetAbs), 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(targetAbs, version) {
  const dest = manifestPath(targetAbs);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(
    dest,
    JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2) + '\n'
  );
}

// Best-effort check against the npm registry. Never throws or rejects —
// resolves null on any failure (offline, registry down, timeout) so callers
// can treat "unknown" and "couldn't check" identically with no extra
// error-handling of their own.
function fetchLatestVersion(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = https.get(
      'https://registry.npmjs.org/github-delivery-os/latest',
      { headers: { 'User-Agent': 'github-delivery-os-cli' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            done(JSON.parse(data).version || null);
          } catch {
            done(null);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => done(null));
  });
}

function getPackageRoot() {
  // When installed via npm, __dirname is node_modules/github-delivery-os/src
  const possibleRoots = [
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..', '..'), // npx: node_modules/.bin/../../
  ];
  for (const root of possibleRoots) {
    const workflowsPath = path.join(root, '.github', 'workflows', 'sprint-child-creator.yml');
    if (fs.existsSync(workflowsPath)) {
      return root;
    }
  }
  throw new Error('Could not find package assets. Ensure .github/workflows exists.');
}

function runInstall(options) {
  const {
    targetDir = '.',
    withTemplates = false,
    withLabels = false,
    withSkill = false,
    overwrite = false,
    dryRun = false,
  } = options;

  const pkgRoot = getPackageRoot();
  const workflowsSrc = path.join(pkgRoot, '.github', 'workflows');
  const templatesSrc = path.join(pkgRoot, '.github', 'ISSUE_TEMPLATE');
  const skillSrc = path.join(pkgRoot, SKILL_REL_PATH);
  const targetAbs = path.resolve(process.cwd(), targetDir);

  console.log('=== GitHub Delivery Operating System ===');
  console.log(`Target: ${targetAbs}`);

  if (overwrite) {
    console.log('');
    console.log('⚠️  WARNING: Overwrite mode — existing Delivery OS workflows/templates will be REPLACED.');
    console.log('    (Your other workflows/templates with different names are not affected.)');
    console.log('');
  } else if (dryRun) {
    console.log('Mode: dry-run (no files will be changed)');
    console.log('');
  } else {
    console.log('Mode: skip-existing (existing workflows/templates will NOT be overwritten)');
    console.log('');
  }

  // Ensure target structure
  const workflowsDest = path.join(targetAbs, '.github', 'workflows');
  const templatesDest = path.join(targetAbs, '.github', 'ISSUE_TEMPLATE');

  if (!dryRun) {
    fs.mkdirSync(workflowsDest, { recursive: true });
    fs.mkdirSync(templatesDest, { recursive: true });
  }

  let workflowsCopied = 0;
  let templatesCopied = 0;
  let skillCopied = 0;
  let workflowsSkipped = 0;
  let templatesSkipped = 0;
  let skillSkipped = 0;

  // Copy workflows
  for (const wf of WORKFLOWS) {
    const src = path.join(workflowsSrc, `${wf}.yml`);
    const dest = path.join(workflowsDest, `${wf}.yml`);

    if (!fs.existsSync(src)) {
      console.log(`  Warning: source not found: ${wf}.yml`);
      continue;
    }

    if (fs.existsSync(dest) && !overwrite) {
      console.log(`  Skipped (exists): ${wf}.yml`);
      workflowsSkipped++;
    } else if (dryRun) {
      console.log(`  [dry-run] Would create: ${wf}.yml`);
      workflowsCopied++;
    } else {
      fs.copyFileSync(src, dest);
      console.log(`  Created: ${wf}.yml`);
      workflowsCopied++;
    }
  }

  // Copy templates
  if (withTemplates && fs.existsSync(templatesSrc)) {
    const files = fs.readdirSync(templatesSrc);
    for (const name of files) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
      const src = path.join(templatesSrc, name);
      const dest = path.join(templatesDest, name);
      if (!fs.statSync(src).isFile()) continue;

      if (fs.existsSync(dest) && !overwrite) {
        console.log(`  Skipped (exists): ${name}`);
        templatesSkipped++;
      } else if (dryRun) {
        console.log(`  [dry-run] Would create template: ${name}`);
        templatesCopied++;
      } else {
        fs.copyFileSync(src, dest);
        console.log(`  Created template: ${name}`);
        templatesCopied++;
      }
    }
  }

  // Copy the delivery-ops Claude Code skill (opt-in — most consumer repos
  // aren't using Claude Code, so this is never written unless asked for)
  if (withSkill && fs.existsSync(skillSrc)) {
    const skillDest = skillPath(targetAbs);

    if (fs.existsSync(skillDest) && !overwrite) {
      console.log(`  Skipped (exists): ${SKILL_REL_PATH}`);
      skillSkipped++;
    } else if (dryRun) {
      console.log(`  [dry-run] Would create: ${SKILL_REL_PATH}`);
      skillCopied++;
    } else {
      fs.mkdirSync(path.dirname(skillDest), { recursive: true });
      fs.copyFileSync(skillSrc, skillDest);
      console.log(`  Created: ${SKILL_REL_PATH}`);
      skillCopied++;
    }
  }

  // Create labels via gh
  let labelsCreated = 0;
  let labelsSkipReason = '';

  if (withLabels) {
    if (dryRun) {
      labelsSkipReason = 'Skipped in dry-run.';
      console.log('  [dry-run] Labels would be created (skipped)');
    } else {
      try {
        execFileSync('gh', ['--version'], { stdio: 'ignore' });
      } catch {
        labelsSkipReason = 'gh CLI not installed. Install from https://cli.github.com/';
        console.log(`  Skipped labels: ${labelsSkipReason}`);
      }

      if (!labelsSkipReason && !fs.existsSync(path.join(targetAbs, '.git'))) {
        labelsSkipReason = 'Target is not a git repository.';
        console.log(`  Skipped labels: ${labelsSkipReason}`);
      }

      if (!labelsSkipReason) {
        try {
          execFileSync('gh', ['auth', 'status'], { cwd: targetAbs, stdio: 'ignore' });
        } catch {
          labelsSkipReason = 'gh CLI not authenticated. Run: gh auth login';
          console.log(`  Skipped labels: ${labelsSkipReason}`);
        }
      }

      if (!labelsSkipReason) {
        try {
          execFileSync('gh', ['repo', 'view'], { cwd: targetAbs, stdio: 'ignore' });
        } catch {
          labelsSkipReason = 'Target repo not on GitHub or no push access.';
          console.log(`  Skipped labels: ${labelsSkipReason}`);
        }
      }

      if (!labelsSkipReason) {
        for (const [name, color] of LABELS) {
          try {
            execFileSync('gh', ['label', 'create', name, '--color', color], {
              cwd: targetAbs,
              stdio: 'pipe',
            });
            console.log(`  Created label: ${name}`);
            labelsCreated++;
          } catch (err) {
            const msg = err.stderr?.toString() || err.message || '';
            if (/already exists/i.test(msg)) {
              console.log(`  Skipped (exists): ${name}`);
            } else {
              console.log(`  Failed to create label '${name}': ${msg.trim()}`);
            }
          }
        }
      }
    }
  }

  // Record what got installed so `status` can report a version and detect
  // drift. Only claim a version when the on-disk files actually match it: an
  // overwrite, or a fresh install where nothing had to be skipped. A partial
  // skip-mode install would leave older file content on disk, so don't
  // overwrite a previously recorded (possibly accurate, possibly newer)
  // version with a number that isn't actually true on disk yet.
  const cleanInstall = overwrite || (workflowsSkipped === 0 && templatesSkipped === 0 && skillSkipped === 0);
  if (!dryRun && cleanInstall) {
    const pkgVersion = require(path.join(pkgRoot, 'package.json')).version;
    writeManifest(targetAbs, pkgVersion);
  }

  // Summary
  console.log('');
  if (!dryRun && !cleanInstall) {
    console.log('  Note: some files already existed and were skipped, so the recorded');
    console.log('  Delivery OS version was not updated. Re-run with --overwrite to sync');
    console.log('  all files (and the recorded version) to the latest release.');
    console.log('');
  }
  if (workflowsCopied > 0 || templatesCopied > 0 || skillCopied > 0 || labelsCreated > 0) {
    if (dryRun) {
      if (workflowsCopied > 0) console.log(`Would install ${workflowsCopied} workflow(s).`);
      if (templatesCopied > 0) console.log(`Would copy ${templatesCopied} issue template(s).`);
      if (skillCopied > 0) console.log('Would add the Claude Code delivery-ops skill.');
    } else {
      if (workflowsCopied > 0) console.log(`Installed ${workflowsCopied} workflow(s).`);
      if (templatesCopied > 0) console.log(`Copied ${templatesCopied} issue template(s).`);
      if (skillCopied > 0) console.log('Added the Claude Code delivery-ops skill.');
      if (labelsCreated > 0) console.log(`Created ${labelsCreated} label(s).`);
    }
    console.log('');
    console.log('Next steps:');
    console.log('  1. Create labels: Actions → Setup Labels → Run workflow');
    if (labelsSkipReason) console.log(`     (Labels skipped: ${labelsSkipReason})`);
    console.log('  2. Configure repo variables (Settings → Secrets and variables → Actions):');
    console.log('     - RELEASE_APPROVER: GitHub username of release approver');
    console.log('     - QA_APPROVER: GitHub username of QA approver');
    console.log('     - QA_ASSIGNEES: Comma-separated usernames for QA assignment');
    console.log('  3. Add secrets (optional, for Telegram): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
    let nextStep = 4;
    if (!withTemplates) {
      console.log(`  ${nextStep}. Copy templates: re-run with --with-templates`);
      nextStep++;
    }
    if (!withSkill) {
      console.log(`  ${nextStep}. Add the Claude Code delivery-ops skill (optional, for Claude Code users): re-run with --with-skill`);
      nextStep++;
    }
    console.log('');
    console.log('See https://phaneroo.github.io/github-delivery-operating-system/ for full docs.');
  } else {
    if (dryRun) {
      console.log('Dry run complete. No files were changed.');
    } else {
      console.log('No new files created (existing files were skipped).');
      console.log('To update: use --overwrite (run with --dry-run first to preview).');
    }
  }
  console.log('');
  console.log('=== Installation complete ===');
}

const TEMPLATES = [
  'config.yml',
  'sprint_planning.yml',
  'task.yml',
  'qa_request.yml',
  'production_release_qa_signoff.yml',
  'bug_report.yml',
];

async function runStatus(options) {
  const { targetDir = '.', checkUpdates = true } = options;
  const targetAbs = path.resolve(process.cwd(), targetDir);
  const workflowsDest = path.join(targetAbs, '.github', 'workflows');
  const templatesDest = path.join(targetAbs, '.github', 'ISSUE_TEMPLATE');

  console.log('=== GitHub Delivery Operating System — Status ===');
  console.log(`Target: ${targetAbs}`);
  console.log('');

  const installedWorkflows = WORKFLOWS.filter((wf) =>
    fs.existsSync(path.join(workflowsDest, `${wf}.yml`))
  );
  const installedTemplates = TEMPLATES.filter((t) =>
    fs.existsSync(path.join(templatesDest, t))
  );
  const skillInstalled = fs.existsSync(skillPath(targetAbs));

  if (installedWorkflows.length > 0 || installedTemplates.length > 0) {
    const manifest = readManifest(targetAbs);
    if (manifest && manifest.version) {
      const installedOn = manifest.installedAt ? ` (installed ${manifest.installedAt.slice(0, 10)})` : '';
      console.log(`Installed version: ${manifest.version}${installedOn}`);
    } else {
      console.log('Installed version: unknown (installed before version tracking was added)');
      console.log('  Run install with --overwrite to record the current version.');
    }

    if (checkUpdates) {
      const latest = await fetchLatestVersion();
      if (!latest) {
        console.log('  (Could not check npm for the latest version — offline or registry unreachable.)');
      } else if (manifest && manifest.version === latest) {
        console.log(`✓ Up to date (latest is ${latest})`);
      } else if (manifest && manifest.version) {
        console.log(`⬆️  Update available: ${manifest.version} → ${latest}`);
        console.log('    Run: npx github-delivery-os@latest install --overwrite .');
      } else {
        console.log(`Latest published version: ${latest}`);
      }
    }
    console.log('');
  }

  if (installedWorkflows.length > 0) {
    console.log('Workflows:');
    installedWorkflows.forEach((wf) => console.log(`  ✓ ${wf}.yml`));
    console.log('');
  }
  if (installedTemplates.length > 0) {
    console.log('Templates:');
    installedTemplates.forEach((t) => console.log(`  ✓ ${t}`));
    console.log('');
  }

  const missingWorkflows = WORKFLOWS.filter((wf) => !installedWorkflows.includes(wf));
  if (missingWorkflows.length > 0) {
    console.log('Missing workflows:');
    missingWorkflows.forEach((wf) => console.log(`  ○ ${wf}.yml`));
    console.log('');
  }

  if (installedWorkflows.length > 0 || installedTemplates.length > 0) {
    console.log('Claude Code skill:');
    console.log(
      skillInstalled
        ? '  ✓ delivery-ops'
        : '  ○ delivery-ops (not installed — re-run install with --with-skill)'
    );
    console.log('');
  }

  if (installedWorkflows.length === 0 && installedTemplates.length === 0) {
    console.log('Delivery OS is not installed in this repository.');
    console.log('Run: npx github-delivery-os install --with-templates .');
  } else {
    console.log(
      `Summary: ${installedWorkflows.length}/${WORKFLOWS.length} workflows, ${installedTemplates.length}/${TEMPLATES.length} templates, skill: ${skillInstalled ? 'yes' : 'no'}`
    );
  }
  console.log('');
}

function runUninstall(options) {
  const { targetDir = '.', withTemplates = false, withSkill = false, dryRun = false } = options;
  const targetAbs = path.resolve(process.cwd(), targetDir);
  const workflowsDest = path.join(targetAbs, '.github', 'workflows');
  const templatesDest = path.join(targetAbs, '.github', 'ISSUE_TEMPLATE');

  console.log('=== GitHub Delivery Operating System — Uninstall ===');
  console.log(`Target: ${targetAbs}`);
  if (dryRun) console.log('Mode: dry-run (no files will be deleted)');
  console.log('');

  let workflowsRemoved = 0;
  let templatesRemoved = 0;

  for (const wf of WORKFLOWS) {
    const dest = path.join(workflowsDest, `${wf}.yml`);
    if (fs.existsSync(dest)) {
      if (dryRun) {
        console.log(`  [dry-run] Would remove: ${wf}.yml`);
      } else {
        fs.unlinkSync(dest);
        console.log(`  Removed: ${wf}.yml`);
      }
      workflowsRemoved++;
    }
  }

  if (withTemplates) {
    for (const t of TEMPLATES) {
      const dest = path.join(templatesDest, t);
      if (fs.existsSync(dest)) {
        if (dryRun) {
          console.log(`  [dry-run] Would remove template: ${t}`);
        } else {
          fs.unlinkSync(dest);
          console.log(`  Removed template: ${t}`);
        }
        templatesRemoved++;
      }
    }
  }

  let skillRemoved = 0;
  if (withSkill) {
    const skillDest = skillPath(targetAbs);
    if (fs.existsSync(skillDest)) {
      if (dryRun) {
        console.log(`  [dry-run] Would remove: ${SKILL_REL_PATH}`);
      } else {
        fs.unlinkSync(skillDest);
        console.log(`  Removed: ${SKILL_REL_PATH}`);
      }
      skillRemoved++;
    }
  }

  // Remove the version manifest too — it has no meaning once Delivery OS is
  // gone, and leaving it behind would make a later install/status think a
  // stale version is still installed.
  const manifestDest = manifestPath(targetAbs);
  if (fs.existsSync(manifestDest)) {
    if (dryRun) {
      console.log('  [dry-run] Would remove: delivery-os.json');
    } else {
      fs.unlinkSync(manifestDest);
      console.log('  Removed: delivery-os.json');
    }
  }

  console.log('');
  if (workflowsRemoved > 0 || templatesRemoved > 0 || skillRemoved > 0) {
    const templateNote = withTemplates ? `, ${templatesRemoved} template(s)` : '';
    const skillNote = withSkill ? `, ${skillRemoved} skill file(s)` : '';
    if (dryRun) {
      console.log(`Would remove ${workflowsRemoved} workflow(s)${templateNote}${skillNote}.`);
    } else {
      console.log(`Removed ${workflowsRemoved} workflow(s)${templateNote}${skillNote}.`);
      if (!withTemplates) {
        console.log('Templates were kept. Re-run with --with-templates to remove them.');
      }
      if (!withSkill) {
        console.log('Claude Code skill (if installed) was kept. Re-run with --with-skill to remove it.');
      }
    }
  } else {
    console.log('No Delivery OS files found to remove.');
  }
  console.log('');
  console.log('=== Uninstall complete ===');
}

module.exports = {
  runInstall,
  runStatus,
  runUninstall,
  // Exposed for tests only — not part of the CLI's public API.
  __test__: {
    manifestPath,
    readManifest,
    writeManifest,
    fetchLatestVersion,
    skillPath,
    SKILL_REL_PATH,
    WORKFLOWS,
    TEMPLATES,
  },
};
