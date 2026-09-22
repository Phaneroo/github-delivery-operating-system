const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const MANIFEST_FILE = 'delivery-os.json'; // written to .github/delivery-os.json in the target repo
const SKILL_REL_PATH = path.join('.claude', 'skills', 'delivery-ops', 'SKILL.md'); // opt-in via --with-skill

// If you add/remove/rename an entry here, also update package.json's "files"
// array — it lists these paths explicitly (not the whole .github/workflows
// directory) so this package's own maintainer workflows (ci.yml, release.yml,
// pages.yml) don't get bundled into what ships to consumers.
const WORKFLOWS = [
  'sprint-child-creator',
  'auto-close-sprint',
  'notify-release-approver',
  'authorize-deployment',
  'auto-assign-qa',
  'telegram-issues',
  'setup-labels',
  'auto-qa-request',
];

// Pure logic some of the workflows above require() at runtime from
// .github/scripts/<name>.js (see .github/workflows/authorize-deployment.yml
// etc.) — these are required dependencies of those workflows, not optional,
// so they're always copied alongside them, the same as WORKFLOWS. Also list
// them explicitly in package.json's "files". `labels` isn't require()'d by
// logic exactly like the others, but setup-labels.yml requires it the same
// way once installed — see loadLabels() below. Its sibling data file,
// labels.tsv, is copied separately (different extension) — see LABELS_TSV.
const SCRIPTS = ['authorize-deployment-verdict', 'auto-close-sprint', 'sprint-child-creator', 'auto-qa-request', 'labels'];
const LABELS_TSV = 'labels.tsv';

// These scripts are CommonJS (`require`/`module.exports`). Node picks CJS vs.
// ESM per-file by walking up to the nearest package.json — so a consumer repo
// whose own root package.json has `"type": "module"` would otherwise make
// Node treat these .js files as ES modules too, breaking `require()` at
// runtime with "ReferenceError: module is not defined in ES module scope".
// This override pins the .github/scripts subtree to CommonJS regardless of
// the consumer's own type field. Always installed alongside SCRIPTS, same as
// SCRIPTS is alongside WORKFLOWS — not itself require()'d by anything, but a
// required dependency of every script that is.
const SCRIPTS_PACKAGE_JSON = 'package.json';

// Which workflow requires which script, so `status` can flag a workflow
// that's present but whose required script is missing (an install that will
// fail with MODULE_NOT_FOUND the next time that workflow actually runs).
// Each of these has require()'d its script since the workflow was first
// introduced — an unconditional dependency for as long as the workflow has
// existed. setup-labels.yml is NOT here because that's not true for it (see
// setupLabelsMissingFiles below): it was self-contained before 1.5.1, so
// whether it requires labels.js/labels.tsv depends on which version of the
// workflow content is actually installed, not just on whether the workflow
// is installed at all.
const REQUIRED_SCRIPT_BY_WORKFLOW = {
  'authorize-deployment': 'authorize-deployment-verdict',
  'auto-close-sprint': 'auto-close-sprint',
  'sprint-child-creator': 'sprint-child-creator',
  'auto-qa-request': 'auto-qa-request',
};

// setup-labels.yml-specific broken-install check. Returns the filenames
// under .github/scripts that are missing, or [] if either the workflow
// isn't the require()-based version or nothing's missing.
//
// An earlier version of this check compared the manifest's recorded version
// against 1.5.1 instead of reading the workflow file's own content — reverted
// because the manifest can be stale relative to what's actually on disk: an
// `install --update` run that touched workflows but didn't also pass
// --with-templates/--with-skill (when those were previously installed)
// deliberately leaves the recorded version behind, per the cleanInstall
// check in runInstall — so "manifest says pre-1.5.1" doesn't reliably mean
// "the installed setup-labels.yml is pre-1.5.1". Reading the installed
// file's own content answers the actual question directly.
function setupLabelsRequiresLabelsFormat(workflowsDest) {
  try {
    return fs.readFileSync(path.join(workflowsDest, 'setup-labels.yml'), 'utf8').includes('labels.js');
  } catch {
    return false;
  }
}

// `requiresLabelsFormat` is the caller-computed result of
// setupLabelsRequiresLabelsFormat() — passed in rather than recomputed here
// so callers checking both this and scriptsRequiringPkgJson (see runStatus)
// only read setup-labels.yml's content once per `status` invocation.
function setupLabelsMissingFiles(targetAbs, requiresLabelsFormat) {
  if (!requiresLabelsFormat) return []; // pre-1.5.1, self-contained, requires nothing
  const scriptsDir = path.join(targetAbs, '.github', 'scripts');
  const missing = [];
  if (!fs.existsSync(path.join(scriptsDir, 'labels.js'))) missing.push('labels.js');
  if (!fs.existsSync(path.join(scriptsDir, LABELS_TSV))) missing.push(LABELS_TSV);
  return missing;
}

// Label definitions (name/color/description) live in .github/scripts/labels.tsv
// — the single source of truth also read by setup-labels.yml (once installed
// into a consumer repo) and scripts/install.sh, so there's exactly one place
// to update instead of three independently hand-maintained copies (see
// https://github.com/Phaneroo/github-delivery-operating-system/issues/20).
// labels.js is a thin parser over that data file, kept as real JS so
// setup-labels.yml's require() and this function share the same parsing
// logic instead of each re-implementing it. Loaded from this package's own
// tree (not a consumer repo's), so it's resolved via getPackageRoot() at the
// point of use inside runInstall, same as every other source path. Throws if
// labels.tsv is missing/unreadable — callers must handle that explicitly
// (see the try/catch around this call in runInstall) rather than letting it
// propagate as an uncaught crash mid-install.
function loadLabels(pkgRoot) {
  const scriptsDir = path.join(pkgRoot, '.github', 'scripts');
  return require(path.join(scriptsDir, 'labels.js')).readLabels(scriptsDir);
}

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

// Copies each `${name}${ext}` from srcDir to destDir for a fixed list of
// expected filenames — the shared logic behind copying WORKFLOWS and SCRIPTS
// (both: a required, always-on set of individually-named files, as opposed
// to templates, which copies whatever's found in a directory, or the skill,
// a single optional file). `label` is what's printed for each entry, e.g.
// `.github/scripts/auto-close-sprint.js` — pass names already including
// their directory prefix so log lines are self-explanatory on their own.
function copyManagedFiles(names, ext, srcDir, destDir, { overwrite, dryRun, relDir }) {
  let copied = 0;
  let skipped = 0;

  for (const name of names) {
    const src = path.join(srcDir, `${name}${ext}`);
    const dest = path.join(destDir, `${name}${ext}`);
    const label = `${relDir}/${name}${ext}`;

    if (!fs.existsSync(src)) {
      console.log(`  Warning: source not found: ${label}`);
      skipped++; // missing source must block a "clean install" claim, not just warn
      continue;
    }

    if (fs.existsSync(dest) && !overwrite) {
      console.log(`  Skipped (exists): ${label}`);
      skipped++;
    } else if (dryRun) {
      console.log(`  [dry-run] Would create: ${label}`);
      copied++;
    } else {
      fs.copyFileSync(src, dest);
      console.log(`  Created: ${label}`);
      copied++;
    }
  }

  return { copied, skipped };
}

// A single extra file that travels alongside SCRIPTS but isn't itself a
// `.js` script (SCRIPTS_PACKAGE_JSON, LABELS_TSV) — splits its extension via
// path.parse so copyManagedFiles' single-extension-per-call shape still
// applies to a one-off filename instead of a list sharing one extension.
function copySingleManagedFile(fullName, srcDir, destDir, opts) {
  const { name, ext } = path.parse(fullName);
  return copyManagedFiles([name], ext, srcDir, destDir, opts);
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
  const scriptsSrc = path.join(pkgRoot, '.github', 'scripts');
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
  const scriptsDest = path.join(targetAbs, '.github', 'scripts');

  if (!dryRun) {
    fs.mkdirSync(workflowsDest, { recursive: true });
    fs.mkdirSync(templatesDest, { recursive: true });
    fs.mkdirSync(scriptsDest, { recursive: true });
  }

  let workflowsCopied = 0;
  let templatesCopied = 0;
  let scriptsCopied = 0;
  let skillCopied = 0;
  let workflowsSkipped;
  let scriptsSkipped;

  // Copy workflows (always on — not optional)
  ({ copied: workflowsCopied, skipped: workflowsSkipped } = copyManagedFiles(
    WORKFLOWS,
    '.yml',
    workflowsSrc,
    workflowsDest,
    { overwrite, dryRun, relDir: '.github/workflows' }
  ));

  // Copy the scripts the workflows above require() at runtime — required,
  // not optional, so (unlike templates/skill) this always runs too.
  ({ copied: scriptsCopied, skipped: scriptsSkipped } = copyManagedFiles(
    SCRIPTS,
    '.js',
    scriptsSrc,
    scriptsDest,
    { overwrite, dryRun, relDir: '.github/scripts' }
  ));

  // The CommonJS-pinning package.json (see SCRIPTS_PACKAGE_JSON above) and
  // labels.tsv (the data file labels.js, just copied via SCRIPTS, parses) —
  // each a single extra file that travels alongside SCRIPTS, always
  // installed the same way, counted the same way (mirrors how
  // scripts/install.sh reuses copy_managed_files for these exact files
  // rather than hand-rolling the copy).
  for (const extra of [SCRIPTS_PACKAGE_JSON, LABELS_TSV]) {
    const result = copySingleManagedFile(extra, scriptsSrc, scriptsDest, {
      overwrite,
      dryRun,
      relDir: '.github/scripts',
    });
    scriptsCopied += result.copied;
    scriptsSkipped += result.skipped;
  }

  let templatesSkipped = 0;
  let skillSkipped = 0;

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

      let labelDefs = [];
      if (!labelsSkipReason) {
        try {
          labelDefs = loadLabels(pkgRoot);
        } catch (err) {
          labelsSkipReason = `Could not read label definitions: ${err.message}`;
          console.log(`  Skipped labels: ${labelsSkipReason}`);
        }
      }

      if (!labelsSkipReason) {
        for (const [name, color, description] of labelDefs) {
          try {
            const args = ['label', 'create', name, '--color', color];
            if (description) args.push('--description', description);
            execFileSync('gh', args, {
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
  // drift. Only claim a version when the on-disk files actually match it.
  //
  // Two ways this can go wrong, both of which must block the claim:
  //  1. A skip-mode install left older content on disk for something that
  //     WAS requested this run (tracked by the *Skipped counters below).
  //  2. An --overwrite run touches only what was explicitly requested
  //     (workflows + scripts always; templates/skill only if their flags
  //     were passed) — templates or skill already on disk from an earlier
  //     install, but not requested this run, are left untouched and stale,
  //     even though --overwrite makes every *Skipped counter read 0. Naively
  //     trusting `overwrite` alone would then claim the whole install is
  //     current when part of it demonstrably wasn't touched.
  const templatesPresentButNotTouched =
    !withTemplates && TEMPLATES.some((t) => fs.existsSync(path.join(templatesDest, t)));
  const skillPresentButNotTouched = !withSkill && fs.existsSync(skillPath(targetAbs));
  const cleanInstall =
    workflowsSkipped === 0 &&
    templatesSkipped === 0 &&
    scriptsSkipped === 0 &&
    skillSkipped === 0 &&
    !templatesPresentButNotTouched &&
    !skillPresentButNotTouched;
  if (!dryRun && cleanInstall) {
    const pkgVersion = require(path.join(pkgRoot, 'package.json')).version;
    writeManifest(targetAbs, pkgVersion);
  }

  // Summary
  console.log('');
  if (!dryRun && !cleanInstall) {
    if (templatesPresentButNotTouched || skillPresentButNotTouched) {
      console.log('  Note: previously-installed templates and/or the Claude Code skill exist');
      console.log('  on disk but were not requested this run, so the recorded Delivery OS');
      console.log('  version was not updated. Re-run with --update plus --with-templates');
      console.log('  and/or --with-skill to bring everything (and the recorded version) in sync.');
    } else {
      console.log('  Note: some files already existed and were skipped, so the recorded');
      console.log('  Delivery OS version was not updated. Re-run with --update to sync');
      console.log('  all files (and the recorded version) to the latest release.');
    }
    console.log('');
  }
  if (workflowsCopied > 0 || templatesCopied > 0 || scriptsCopied > 0 || skillCopied > 0 || labelsCreated > 0) {
    if (dryRun) {
      if (workflowsCopied > 0) console.log(`Would install ${workflowsCopied} workflow(s).`);
      if (templatesCopied > 0) console.log(`Would copy ${templatesCopied} issue template(s).`);
      if (scriptsCopied > 0) console.log(`Would install ${scriptsCopied} supporting script(s).`);
      if (skillCopied > 0) console.log('Would add the Claude Code delivery-ops skill.');
    } else {
      if (workflowsCopied > 0) console.log(`Installed ${workflowsCopied} workflow(s).`);
      if (templatesCopied > 0) console.log(`Copied ${templatesCopied} issue template(s).`);
      if (scriptsCopied > 0) console.log(`Installed ${scriptsCopied} supporting script(s).`);
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
      console.log('To update: use --update (run with --dry-run first to preview).');
    }
  }
  console.log('');
  console.log('=== Installation complete ===');
}

// runInstall only records a new manifest version when everything already
// installed actually gets touched this run (see the cleanInstall check
// there) — so a repo with templates and/or the skill already on disk needs
// --with-templates/--with-skill passed again on an update, not just
// --update, or the recorded version never advances and `status` keeps
// suggesting the same command forever. Build the hint from what's actually
// on disk so it's never wrong.
function buildUpdateCommand({ hasTemplates, hasSkill }) {
  // --with-labels is unconditional, unlike --with-templates/--with-skill —
  // those add a whole category of files a repo may have deliberately never
  // wanted, but label sync is idempotent (skips anything that already
  // exists, only creates what's missing) and this is the one command
  // status/broken-install hints point people at to "catch up" fully. Leaving
  // it out meant the suggested command could complete without error while
  // silently missing a label a newer release added (delivery-ops-filed, in
  // 1.7.0) — the repo would show as "up to date" with no indication
  // anything was still missing.
  const flags = [
    hasTemplates ? '--with-templates' : null,
    hasSkill ? '--with-skill' : null,
    '--with-labels',
    '--update',
  ]
    .filter(Boolean)
    .join(' ');
  return `npx github-delivery-os@latest install ${flags} .`;
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

  // Read setup-labels.yml's content (if installed) exactly once and reuse
  // the result below — both brokenWorkflowDetails and scriptsRequiringPkgJson
  // otherwise each independently re-read the same file.
  const setupLabelsInstalled = installedWorkflows.includes('setup-labels');
  const setupLabelsOnCurrentFormat = setupLabelsInstalled && setupLabelsRequiresLabelsFormat(workflowsDest);

  // A workflow can be present while the script(s) it require()s at runtime
  // are not — e.g. an install from before this check existed, or a manual
  // partial copy. That workflow will fail (MODULE_NOT_FOUND) the next time
  // it actually runs, silently, since nothing here executes the workflow
  // itself to notice. Each entry names exactly what's missing (not just
  // which workflow), so the message below is never wrong about which file
  // to look for.
  const brokenWorkflowDetails = installedWorkflows
    .map((wf) => {
      if (wf === 'setup-labels') {
        return { wf, missing: setupLabelsMissingFiles(targetAbs, setupLabelsOnCurrentFormat) };
      }
      const requiredScript = REQUIRED_SCRIPT_BY_WORKFLOW[wf];
      if (!requiredScript) return { wf, missing: [] };
      const scriptFile = `${requiredScript}.js`;
      const missing = fs.existsSync(path.join(targetAbs, '.github', 'scripts', scriptFile)) ? [] : [scriptFile];
      return { wf, missing };
    })
    .filter((d) => d.missing.length > 0);

  // A script can be present while the CommonJS-pinning package.json (see
  // SCRIPTS_PACKAGE_JSON in src/install.js) is missing — e.g. an install from
  // before this fix existed. That's fine in a repo whose own package.json
  // has no "type" field or "type": "commonjs", but breaks with
  // "ReferenceError: module is not defined in ES module scope" the moment
  // the consumer repo's package.json has "type": "module". Flagged
  // separately from brokenWorkflowDetails since it's silent until that
  // condition is hit, not an immediate break.
  const scriptsRequiringPkgJson = installedWorkflows.some((wf) => {
    if (wf === 'setup-labels') return setupLabelsOnCurrentFormat;
    return Boolean(REQUIRED_SCRIPT_BY_WORKFLOW[wf]);
  });
  const scriptsPkgJsonMissing =
    scriptsRequiringPkgJson &&
    !fs.existsSync(path.join(targetAbs, '.github', 'scripts', SCRIPTS_PACKAGE_JSON));

  if (installedWorkflows.length > 0 || installedTemplates.length > 0 || skillInstalled) {
    const manifest = readManifest(targetAbs);
    if (manifest && manifest.version) {
      const installedOn = manifest.installedAt ? ` (installed ${manifest.installedAt.slice(0, 10)})` : '';
      console.log(`Installed version: ${manifest.version}${installedOn}`);
    } else {
      console.log('Installed version: unknown (installed before version tracking was added)');
      console.log(
        `  Run: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled })}`
      );
    }

    if (checkUpdates) {
      const latest = await fetchLatestVersion();
      if (!latest) {
        console.log('  (Could not check npm for the latest version — offline or registry unreachable.)');
      } else if (manifest && manifest.version === latest) {
        console.log(`✓ Up to date (latest is ${latest})`);
      } else if (manifest && manifest.version) {
        console.log(`⬆️  Update available: ${manifest.version} → ${latest}`);
        console.log(
          `    Run: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled })}`
        );
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

  if (brokenWorkflowDetails.length > 0) {
    console.log('⚠️  Broken install detected:');
    brokenWorkflowDetails.forEach(({ wf, missing }) => {
      const files = missing.map((f) => `.github/scripts/${f}`).join(' and ');
      const verb = missing.length > 1 ? 'are' : 'is';
      console.log(`  ${wf}.yml requires ${files}, which ${verb} missing.`);
    });
    console.log('  That workflow will fail with MODULE_NOT_FOUND the next time it runs.');
    console.log(
      `  Fix: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled })}`
    );
    console.log('');
  }

  if (scriptsPkgJsonMissing) {
    console.log(`⚠️  .github/scripts/${SCRIPTS_PACKAGE_JSON} is missing.`);
    console.log('  If this repo\'s own package.json has "type": "module", every workflow that');
    console.log('  require()s a script under .github/scripts will fail with "module is not');
    console.log('  defined in ES module scope" the next time it runs.');
    console.log(
      `  Fix: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled })}`
    );
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

  if (installedWorkflows.length > 0 || installedTemplates.length > 0 || skillInstalled) {
    console.log('Claude Code skill:');
    console.log(
      skillInstalled
        ? '  ✓ delivery-ops'
        : '  ○ delivery-ops (not installed — re-run install with --with-skill)'
    );
    console.log('');
  }

  if (installedWorkflows.length === 0 && installedTemplates.length === 0 && !skillInstalled) {
    console.log('Delivery OS is not installed in this repository.');
    console.log('Run: npx github-delivery-os install --with-templates --with-labels --with-skill .');
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
  const scriptsDest = path.join(targetAbs, '.github', 'scripts');

  console.log('=== GitHub Delivery Operating System — Uninstall ===');
  console.log(`Target: ${targetAbs}`);
  if (dryRun) console.log('Mode: dry-run (no files will be deleted)');
  console.log('');

  let workflowsRemoved = 0;
  let templatesRemoved = 0;
  let scriptsRemoved = 0;

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

  // Scripts are a required dependency of the workflows above, not optional,
  // so (like workflows) they're always removed, not gated behind a flag.
  for (const name of SCRIPTS) {
    const dest = path.join(scriptsDest, `${name}.js`);
    if (fs.existsSync(dest)) {
      if (dryRun) {
        console.log(`  [dry-run] Would remove: .github/scripts/${name}.js`);
      } else {
        fs.unlinkSync(dest);
        console.log(`  Removed: .github/scripts/${name}.js`);
      }
      scriptsRemoved++;
    }
  }

  // The CommonJS-pinning package.json and labels.tsv both travel with
  // SCRIPTS — same unconditional removal, same install-side pairing as
  // copySingleManagedFile's [SCRIPTS_PACKAGE_JSON, LABELS_TSV] loop in
  // runInstall.
  for (const extra of [SCRIPTS_PACKAGE_JSON, LABELS_TSV]) {
    const dest = path.join(scriptsDest, extra);
    if (fs.existsSync(dest)) {
      if (dryRun) {
        console.log(`  [dry-run] Would remove: .github/scripts/${extra}`);
      } else {
        fs.unlinkSync(dest);
        console.log(`  Removed: .github/scripts/${extra}`);
      }
      scriptsRemoved++;
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

  // Remove the version manifest too — but only once nothing Delivery-OS-
  // related actually remains. Templates and the skill are kept by default
  // (only removed with their own flags), and if they're still on disk, the
  // manifest's version is still meaningful for them — deleting it would make
  // a later `status` report "unknown version" for files that are, in fact,
  // still fully present and version-tracked.
  const anyWorkflowsRemain = WORKFLOWS.some((wf) => fs.existsSync(path.join(workflowsDest, `${wf}.yml`)));
  const anyTemplatesRemain = TEMPLATES.some((t) => fs.existsSync(path.join(templatesDest, t)));
  // Scripts are removed unconditionally just above, so this is normally
  // always false by the time we get here — included anyway for the same
  // reason the other three are checked explicitly rather than assumed:
  // defensive completeness against a future change (e.g. a failed unlink,
  // or script removal ever becoming flag-gated like templates/skill).
  const anyScriptsRemain =
    SCRIPTS.some((name) => fs.existsSync(path.join(scriptsDest, `${name}.js`))) ||
    fs.existsSync(path.join(scriptsDest, SCRIPTS_PACKAGE_JSON)) ||
    fs.existsSync(path.join(scriptsDest, LABELS_TSV));
  const skillRemains = fs.existsSync(skillPath(targetAbs));
  const nothingLeft = !anyWorkflowsRemain && !anyTemplatesRemain && !anyScriptsRemain && !skillRemains;

  const manifestDest = manifestPath(targetAbs);
  if (nothingLeft && fs.existsSync(manifestDest)) {
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
      if (!nothingLeft) {
        console.log('delivery-os.json was kept — something Delivery-OS-related is still on disk.');
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
    buildUpdateCommand,
    skillPath,
    SKILL_REL_PATH,
    WORKFLOWS,
    TEMPLATES,
    SCRIPTS,
    SCRIPTS_PACKAGE_JSON,
    LABELS_TSV,
    REQUIRED_SCRIPT_BY_WORKFLOW,
    setupLabelsMissingFiles,
    loadLabels,
  },
};
