const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');

const MANIFEST_FILE = 'delivery-os.json'; // written to .github/delivery-os.json in the target repo
const SKILL_REL_PATH = path.join('.claude', 'skills', 'delivery-ops', 'SKILL.md'); // opt-in via --with-skill

// Travels with the skill: a Claude Code SessionStart hook that offers the
// update when the repo's install is behind npm (#90). Registered in the
// repo's .claude/settings.json, merged in next to whatever else is there.
const UPDATE_HOOK_REL_PATH = path.join('.claude', 'hooks', 'delivery-os-update-check.js');
const SETTINGS_REL_PATH = path.join('.claude', 'settings.json');
const UPDATE_HOOK_MARKER = 'delivery-os-update-check.js'; // identifies our entry in settings.json
const UPDATE_HOOK_ENTRY = {
  matcher: 'startup',
  hooks: [
    {
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/delivery-os-update-check.js"',
      timeout: 10,
    },
  ],
};

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
  'qa-rollup-approval',
];

// What a default (full) install puts in a repo: everything except the Telegram
// alerts, which need a bot and two secrets to do anything, so they are opt-in
// (`add telegram`). WORKFLOWS stays the list of every workflow we ship: status,
// list and uninstall use it so an installed Telegram workflow is still known.
const OPT_IN_WORKFLOWS = ['telegram-issues'];
const DEFAULT_WORKFLOWS = WORKFLOWS.filter((wf) => !OPT_IN_WORKFLOWS.includes(wf));

// Pure logic some of the workflows above require() at runtime from
// .github/scripts/<name>.js (see .github/workflows/authorize-deployment.yml
// etc.) — these are required dependencies of those workflows, not optional,
// so they're always copied alongside them, the same as WORKFLOWS. Also list
// them explicitly in package.json's "files". `labels` isn't require()'d by
// logic exactly like the others, but setup-labels.yml requires it the same
// way once installed — see loadLabels() below. Its sibling data file,
// labels.tsv, is copied separately (different extension) — see LABELS_TSV.
const SCRIPTS = ['authorize-deployment-verdict', 'auto-close-sprint', 'sprint-child-creator', 'auto-qa-request', 'release-rollup', 'labels'];
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
  // Shares the verdict matcher with authorize-deployment and the rolling
  // issue body helpers with auto-qa-request — required since it was added.
  'qa-rollup-approval': ['authorize-deployment-verdict', 'auto-qa-request'],
};

// Workflows that only started require()-ing a script in a later release, so
// an older copy on disk legitimately needs nothing. Like setup-labels (see
// below), the dependency is read from the installed file's own content —
// mapping these unconditionally would flag every pre-upgrade install as
// broken. notify-release-approver gained release-rollup.js with the release
// roll-up job.
// Value: the scripts required once the gate is met; the FIRST one is the
// marker looked for in the workflow's content. release-rollup.js itself
// requires auto-qa-request.js (1.9.0, for the rolling QA checklist parser).
const CONTENT_GATED_SCRIPT_BY_WORKFLOW = {
  'notify-release-approver': ['release-rollup', 'auto-qa-request'],
};

// The scripts an installed workflow requires ([] if none) — unconditional
// ones from REQUIRED_SCRIPT_BY_WORKFLOW (a name or a list of names),
// content-gated ones only when the file on disk actually references them.
function requiredScriptsFor(targetAbs, wf) {
  const required = REQUIRED_SCRIPT_BY_WORKFLOW[wf];
  if (required) return [].concat(required);
  const gated = [].concat(CONTENT_GATED_SCRIPT_BY_WORKFLOW[wf] || []);
  if (!gated.length) return [];
  try {
    const content = fs.readFileSync(path.join(targetAbs, '.github', 'workflows', `${wf}.yml`), 'utf8');
    return content.includes(`${gated[0]}.js`) ? gated : [];
  } catch {
    return [];
  }
}

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

function updateHookPath(targetAbs) {
  return path.join(targetAbs, UPDATE_HOOK_REL_PATH);
}

// Our hook is identified item by item (inside an entry's `hooks` list), not
// by whole entry: a user may well have added their own command next to ours
// in the same { matcher, hooks } object, and that must survive an update or
// an uninstall.
function isUpdateHookCommand(h) {
  return Boolean(h && typeof h.command === 'string' && h.command.includes(UPDATE_HOOK_MARKER));
}

function entryHasUpdateHook(entry) {
  return Boolean(entry && Array.isArray(entry.hooks) && entry.hooks.some(isUpdateHookCommand));
}

// Every SessionStart entry with our command taken out; entries left with no
// commands at all are dropped. Anything that isn't one of our commands is
// kept exactly as it was.
function withoutUpdateHook(entries) {
  return entries
    .map((entry) =>
      entryHasUpdateHook(entry) ? { ...entry, hooks: entry.hooks.filter((h) => !isUpdateHookCommand(h)) } : entry
    )
    .filter((entry) => !(entry && Array.isArray(entry.hooks) && entry.hooks.length === 0));
}

// Reads .claude/settings.json: { settings, entries } (empty when the file
// doesn't exist yet) or { error } when it, its "hooks" or its
// "hooks.SessionStart" isn't the shape Claude Code expects — in which case
// callers leave the file alone rather than risk clobbering what's there.
function readSettings(targetAbs) {
  const file = path.join(targetAbs, SETTINGS_REL_PATH);
  if (!fs.existsSync(file)) return { settings: {}, entries: [], exists: false };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: err.message };
  }
  const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(settings)) return { error: 'not a JSON object' };
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return { error: '"hooks" is not an object' };
  const entries = settings.hooks && settings.hooks.SessionStart;
  if (entries !== undefined && !Array.isArray(entries)) return { error: '"hooks.SessionStart" is not a list' };
  return { settings, entries: entries || [], exists: true };
}

function writeSettings(targetAbs, settings) {
  const file = path.join(targetAbs, SETTINGS_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

// Writes `entries` back as hooks.SessionStart, pruning containers left empty,
// and deletes the file only if nothing at all is left in it.
function writeSessionStart(targetAbs, settings, entries) {
  const hooks = { ...(settings.hooks || {}), SessionStart: entries };
  if (entries.length === 0) delete hooks.SessionStart;
  const next = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  if (Object.keys(next).length === 0) {
    fs.rmSync(path.join(targetAbs, SETTINGS_REL_PATH), { force: true });
  } else {
    writeSettings(targetAbs, next);
  }
}

function hasUpdateHookRegistered(targetAbs) {
  const { entries } = readSettings(targetAbs);
  return Array.isArray(entries) && entries.some(entryHasUpdateHook);
}

// Adds our SessionStart entry to .claude/settings.json, keeping every other
// setting and hook as is. An existing registration of ours is refreshed only
// with --update, the same rule as every other installed file: our old
// command is taken out wherever it sits and the current entry appended.
// Returns 'added' | 'updated' | 'exists' | 'error: <reason>'.
function registerUpdateHook(targetAbs, { overwrite, dryRun }) {
  const { settings, entries, error } = readSettings(targetAbs);
  if (error) return `error: ${error}`;
  const present = entries.some(entryHasUpdateHook);
  if (present && !overwrite) return 'exists';
  if (!dryRun) writeSessionStart(targetAbs, settings, [...withoutUpdateHook(entries), UPDATE_HOOK_ENTRY]);
  return present ? 'updated' : 'added';
}

// Removes our command (only ours) from SessionStart. Returns true if it did.
function unregisterUpdateHook(targetAbs, { dryRun }) {
  const { settings, entries, error, exists } = readSettings(targetAbs);
  if (error || !exists || !entries.some(entryHasUpdateHook)) return false;
  if (!dryRun) writeSessionStart(targetAbs, settings, withoutUpdateHook(entries));
  return true;
}

// Numeric x.y.z comparison: true when `version` is older than `than`.
function isOlderVersion(version, than) {
  const a = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(than).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

// 1.9.0 changed auto-qa-request's default from one QA Request per change to
// one rolling QA issue. Worth a note when an --update brings that change to
// a repo that already had the old behavior (a pre-1.9.0 manifest, or no
// manifest at all next to an existing auto-qa-request.yml).
function rollingQaMigrationNote(priorVersion, hadAutoQaWorkflow) {
  if (!hadAutoQaWorkflow) return null;
  if (priorVersion && !isOlderVersion(priorVersion, '1.9.0')) return null;
  return [
    '  Note: auto-qa-request now keeps ONE rolling QA issue ("QA REQUEST - Changes',
    '  awaiting QA") instead of filing a QA Request (+ Task) per change. Each push',
    '  or merged PR adds a line; QA_APPROVER approves it with a comment (e.g.',
    '  "approved", "lgtm", ✅) or by ticking its Approved box.',
    '  - Existing open auto-filed QA Requests were left as they are. The delivery-ops',
    '    skill\'s cleanup sweep can propose closing old leftovers.',
    '  - To keep the old behavior, set the repo variable DELIVERY_OS_AUTO_QA_MODE=per-change',
    '    (DELIVERY_OS_AUTO_QA=all already keeps it). A repo with DELIVERY_OS_AUTO_QA=pr-only',
    '    moves to the rolling issue, PRs only; add DELIVERY_OS_AUTO_QA_MODE=per-change to keep',
    '    a QA Request per PR.',
    '  - Run Setup Labels (or --with-labels) to create the new `qa-rollup` label.',
  ].join('\n');
}

function readManifest(targetAbs) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(targetAbs), 'utf8'));
  } catch {
    return null;
  }
}

// `bundle` is only written when it isn't the default, so a full install's
// manifest looks exactly as it always has.
function writeManifest(targetAbs, version, bundle = DEFAULT_BUNDLE, workflows = null, packs = []) {
  const dest = manifestPath(targetAbs);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const manifest = { version, installedAt: new Date().toISOString() };
  if (bundle !== DEFAULT_BUNDLE) manifest.bundle = bundle;
  // Only when --only/--skip narrowed the bundle.
  if (workflows) manifest.workflows = workflows;
  // Only when optional packs were added to a lite install.
  if (packs.length) manifest.packs = packs;
  fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n');
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

// The delivery-ops skill for a bundle other than full: the same skill with the
// bundle's short addendum (what to skip, how releases work) spliced in ahead of
// the pre-flight check. Full gets the skill byte for byte, so there is one skill
// to maintain, not two.
const SKILL_ANCHOR = '## Pre-flight check\n';
function skillForBundle(base, addendumPath) {
  const addendum = fs.readFileSync(addendumPath, 'utf8');
  const at = base.indexOf(SKILL_ANCHOR);
  if (at === -1) return base + '\n' + addendum; // never lose the addendum if the skill is reorganised
  return base.slice(0, at) + addendum + base.slice(at);
}

// labels.tsv for a bundle that leaves some labels out: the same file, minus
// those lines. Same skip/overwrite/dry-run rules as copyManagedFiles.
function writeFilteredLabels(srcDir, destDir, excluded, { overwrite, dryRun, relDir }) {
  const label = `${relDir}/${LABELS_TSV}`;
  const src = path.join(srcDir, LABELS_TSV);
  const dest = path.join(destDir, LABELS_TSV);
  if (!fs.existsSync(src)) {
    console.log(`  Warning: source not found: ${label}`);
    return { copied: 0, skipped: 1 };
  }
  if (fs.existsSync(dest) && !overwrite) {
    console.log(`  Skipped (exists): ${label}`);
    return { copied: 0, skipped: 1 };
  }
  if (dryRun) {
    console.log(`  [dry-run] Would create: ${label}`);
    return { copied: 1, skipped: 0 };
  }
  const kept = fs.readFileSync(src, 'utf8').split('\n').filter((line) => !excluded.includes(line.split('\t')[0]));
  fs.writeFileSync(dest, kept.join('\n'));
  console.log(`  Created: ${label}`);
  return { copied: 1, skipped: 0 };
}

// Why `gh` can't be used against this target, or '' when it can.
function ghUnavailableReason(targetAbs) {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
  } catch {
    return 'gh CLI not installed. Install from https://cli.github.com/';
  }
  if (!fs.existsSync(path.join(targetAbs, '.git'))) return 'Target is not a git repository.';
  try {
    execFileSync('gh', ['auth', 'status'], { cwd: targetAbs, stdio: 'ignore' });
  } catch {
    return 'gh CLI not authenticated. Run: gh auth login';
  }
  try {
    execFileSync('gh', ['repo', 'view'], { cwd: targetAbs, stdio: 'ignore' });
  } catch {
    return 'Target repo not on GitHub or no push access.';
  }
  return '';
}

// Makes the person running the install the release approver: sets the
// RELEASE_APPROVER repo variable to their GitHub login, and says so. Never
// replaces a value that's already there. Returns { state: 'set' | 'exists' |
// 'skipped' | 'dry-run', login?, reason? }.
function setReleaseApprover(targetAbs, { dryRun }) {
  const NAME = 'RELEASE_APPROVER';
  if (dryRun) {
    console.log(`  [dry-run] Would set ${NAME} to your GitHub login (unless it is already set)`);
    return { state: 'dry-run' };
  }
  const reason = ghUnavailableReason(targetAbs);
  if (reason) {
    console.log(`  Skipped ${NAME}: ${reason}`);
    return { state: 'skipped', reason };
  }
  try {
    const existing = execFileSync('gh', ['variable', 'list', '--json', 'name', '--jq', '.[].name'], {
      cwd: targetAbs,
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((n) => n.trim());
    if (existing.includes(NAME)) {
      console.log(`  Left ${NAME} as it is (already set).`);
      return { state: 'exists' };
    }
    const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { cwd: targetAbs, stdio: 'pipe' }).toString().trim();
    execFileSync('gh', ['variable', 'set', NAME, '--body', login], { cwd: targetAbs, stdio: 'pipe' });
    console.log(`  Set ${NAME} to @${login}: you approve releases in this repo.`);
    console.log('    Change it any time: Settings → Secrets and variables → Actions → Variables.');
    return { state: 'set', login };
  } catch (err) {
    const msg = (err.stderr && err.stderr.toString().trim()) || err.message || '';
    console.log(`  Skipped ${NAME}: ${msg}`);
    return { state: 'skipped', reason: msg };
  }
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

  // No --bundle given: stay on whatever bundle the repo is already on, so a
  // plain `install --update` never quietly widens a lite install to full.
  const targetAbs = path.resolve(process.cwd(), targetDir);
  const priorManifest = readManifest(targetAbs);
  const bundle = options.bundle || manifestBundle(priorManifest);

  if (!Object.prototype.hasOwnProperty.call(BUNDLES, bundle)) {
    console.error(`Unknown bundle "${bundle}". Choose one of: ${Object.keys(BUNDLES).join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  // Where the repo is now, from its manifest: bundle, packs and any explicit set.
  const priorBundle = manifestBundle(priorManifest);
  const priorPacks = manifestPacks(priorManifest, priorBundle);
  const priorEffective = effectiveFor(priorBundle, priorPacks, manifestWorkflows(priorManifest, priorBundle, priorPacks));

  const addNames = parseNameList(options.addNames) || [];
  const removeNames = parseNameList(options.removeNames) || [];
  const changing = addNames.length > 0 || removeNames.length > 0;

  // add/remove edit what is already installed; with nothing installed there is
  // nothing to edit (and the default is every workflow, which add must not install).
  if (changing && !priorManifest && !WORKFLOWS.some((wf) => fs.existsSync(path.join(targetAbs, '.github', 'workflows', `${wf}.yml`)))) {
    console.error('Delivery OS is not installed here. Start with: install --bundle lite (or install).');
    process.exitCode = 1;
    return;
  }
  const unknownNames = [...addNames, ...removeNames].filter((n) => !PACKS[n] && !WORKFLOWS.includes(n));
  if (unknownNames.length) {
    console.error(
      `Unknown name${unknownNames.length > 1 ? 's' : ''}: ${unknownNames.join(', ')}. Packs: ${Object.keys(PACKS).join(', ')}. Workflows: ${WORKFLOWS.join(', ')}.`
    );
    process.exitCode = 1;
    return;
  }

  // --only / --skip replace the whole set (and clear packs); naming a --bundle
  // starts from the bundle alone; otherwise start from what is installed now.
  const selection = resolveSelection({ bundle, only: parseNameList(options.only), skip: parseNameList(options.skip) });
  if (selection.error) {
    console.error(selection.error);
    process.exitCode = 1;
    return;
  }
  let packs;
  let current;
  if (selection.workflows) {
    packs = [];
    current = selection.workflows;
  } else if (options.bundle) {
    packs = [];
    current = defaultSet(bundle, []);
  } else {
    packs = priorPacks;
    current = priorEffective.workflows;
    // A workflow that became opt-in after this repo installed it (Telegram) keeps
    // being updated and checked while it is there, so it never goes stale unseen.
    if (bundle === 'full' && !manifestWorkflows(priorManifest, bundle, priorPacks)) {
      for (const wf of OPT_IN_WORKFLOWS) {
        if (!current.includes(wf) && fs.existsSync(path.join(targetAbs, '.github', 'workflows', `${wf}.yml`))) current = current.concat(wf);
      }
    }
  }
  // add/remove: packs are named groups of workflows (and, on lite, one of them
  // is what makes releases need a QA approver); anything else is one workflow.
  for (const name of addNames) {
    if (PACKS[name]) {
      current = current.concat(PACKS[name].workflows);
      if (bundle === 'lite') packs = packs.concat(name);
    } else {
      current = current.concat(name);
    }
  }
  for (const name of removeNames) {
    const members = PACKS[name] ? PACKS[name].workflows : [name];
    const present = members.some((wf) => priorEffective.workflows.includes(wf)) || packs.includes(name);
    if (!present) console.log(`Note: ${name} isn't installed here.`);
    current = current.filter((wf) => !members.includes(wf));
    packs = packs.filter((p) => p !== name);
  }
  packs = Object.keys(PACKS).filter((p) => packs.includes(p));
  const workflowSet = WORKFLOWS.filter((wf) => current.includes(wf));
  if (workflowSet.length === 0) {
    console.error('That leaves nothing installed. Use uninstall to remove Delivery OS.');
    process.exitCode = 1;
    return;
  }
  // Recorded only when it differs from what the bundle and packs give.
  const customWorkflows = sameSet(workflowSet, defaultSet(bundle, packs)) ? null : workflowSet;
  const effective = effectiveFor(bundle, packs, customWorkflows);
  const flavor = effective.flavor;
  const priorFlavor = priorEffective.flavor;
  const selected = effective;
  const labelsChanged = Boolean(effective.excludedLabels) !== Boolean(priorEffective.excludedLabels);
  const warnings = needsWarnings(workflowSet);

  const pkgRoot = getPackageRoot();
  const workflowsSrc = path.join(pkgRoot, '.github', 'workflows');
  const templatesSrc = path.join(pkgRoot, '.github', 'ISSUE_TEMPLATE');
  const scriptsSrc = path.join(pkgRoot, '.github', 'scripts');
  const skillSrc = path.join(pkgRoot, SKILL_REL_PATH);

  console.log('=== GitHub Delivery Operating System ===');
  console.log(`Target: ${targetAbs}`);
  if (bundle !== DEFAULT_BUNDLE) console.log(`Bundle: ${bundle}`);
  if (packs.length) console.log(`Packs: ${packs.join(', ')}`);
  if (customWorkflows && isCustomSelection(workflowSet, bundle, packs)) console.log(`Workflows: ${workflowSet.join(', ')}`);
  for (const w of warnings) console.log(`Note: ${w}`);

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
  const migrationNote = overwrite
    ? rollingQaMigrationNote(
        priorManifest && priorManifest.version,
        fs.existsSync(path.join(workflowsDest, 'auto-qa-request.yml'))
      )
    : null;
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
  //
  // Naming a different --bundle than the repo is on swaps the files the two
  // bundles keep different versions of (VARIANT_*: the release workflows, the
  // release form, the label list) for the new bundle's, even without --update.
  // They are Delivery OS's own files, and leaving the old bundle's copy in
  // place would quietly keep the old behavior (a lite authorize-deployment
  // ignoring the QA approver on a repo that now says it's full).
  const switching = flavor !== priorFlavor;
  if (switching) {
    console.log(`Switching the release flow to the ${flavor} one: its versions of the release workflows, release form and labels replace the current ones.`);
    console.log('');
  }

  // Taking something away removes the files only it needs (not ones another
  // piece still uses). Your repo variables and secrets are left alone.
  if (removeNames.length) {
    const before = priorEffective;
    const gone = (list, now) => list.filter((x) => !now.includes(x));
    const toRemove = [
      ...gone(before.workflows, effective.workflows).map((wf) => path.join(workflowsDest, `${wf}.yml`)),
      ...gone(before.scripts, effective.scripts).map((name) => path.join(scriptsDest, `${name}.js`)),
      ...gone(before.templates, effective.templates).map((name) => path.join(templatesDest, name)),
    ];
    for (const file of toRemove) {
      if (!fs.existsSync(file)) continue;
      const shown = path.relative(targetAbs, file);
      if (dryRun) {
        console.log(`  [dry-run] Would remove: ${shown}`);
      } else {
        fs.unlinkSync(file);
        console.log(`  Removed: ${shown}`);
      }
    }
  }

  const variantWorkflows = BUNDLES.lite.liteWorkflows;
  const variantSrc = flavor === 'lite' ? path.join(pkgRoot, LITE_REL_DIR, 'workflows') : workflowsSrc;
  workflowsCopied = 0;
  workflowsSkipped = 0;
  // One at a time, in the bundle's order, so the log reads as it always has.
  for (const wf of selected.workflows) {
    const isVariant = variantWorkflows.includes(wf);
    const result = copyManagedFiles([wf], '.yml', isVariant ? variantSrc : workflowsSrc, workflowsDest, {
      overwrite: overwrite || (switching && isVariant),
      dryRun,
      relDir: '.github/workflows',
    });
    workflowsCopied += result.copied;
    workflowsSkipped += result.skipped;
  }

  // Copy the scripts the workflows above require() at runtime — required,
  // not optional, so (unlike templates/skill) this always runs too.
  ({ copied: scriptsCopied, skipped: scriptsSkipped } = copyManagedFiles(
    selected.scripts,
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
    // labels.tsv is one of the files the bundles keep different versions of.
    const opts = { overwrite: overwrite || ((switching || labelsChanged) && extra === LABELS_TSV), dryRun, relDir: '.github/scripts' };
    const result =
      extra === LABELS_TSV && selected.excludedLabels
        ? writeFilteredLabels(scriptsSrc, scriptsDest, selected.excludedLabels, opts)
        : copySingleManagedFile(extra, scriptsSrc, scriptsDest, opts);
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
      // Full copies every template in the directory (as it always has); other
      // bundles copy only their own.
      if (bundle !== DEFAULT_BUNDLE && !selected.templates.includes(name)) continue;
      // Lite's own wording for the release form, under the same name.
      const src = (selected.liteTemplates || []).includes(name)
        ? path.join(pkgRoot, LITE_REL_DIR, 'ISSUE_TEMPLATE', name)
        : path.join(templatesSrc, name);
      const dest = path.join(templatesDest, name);
      if (!fs.statSync(src).isFile()) continue;
      const replaceThis = overwrite || (switching && BUNDLES.lite.liteTemplates.includes(name));

      if (fs.existsSync(dest) && !replaceThis) {
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
      if (bundle === DEFAULT_BUNDLE) {
        fs.copyFileSync(skillSrc, skillDest);
      } else {
        fs.writeFileSync(skillDest, skillForBundle(fs.readFileSync(skillSrc, 'utf8'), path.join(pkgRoot, LITE_REL_DIR, 'skill-addendum.md')));
      }
      console.log(`  Created: ${SKILL_REL_PATH}`);
      skillCopied++;
    }
  }

  // The update-check hook travels with the skill (same flag, same skip/
  // overwrite rule), plus its registration in .claude/settings.json.
  const hookSrc = path.join(pkgRoot, UPDATE_HOOK_REL_PATH);
  if (withSkill && fs.existsSync(hookSrc)) {
    const hookDest = updateHookPath(targetAbs);
    if (fs.existsSync(hookDest) && !overwrite) {
      console.log(`  Skipped (exists): ${UPDATE_HOOK_REL_PATH}`);
      skillSkipped++;
    } else if (dryRun) {
      console.log(`  [dry-run] Would create: ${UPDATE_HOOK_REL_PATH}`);
      skillCopied++;
    } else {
      fs.mkdirSync(path.dirname(hookDest), { recursive: true });
      fs.copyFileSync(hookSrc, hookDest);
      console.log(`  Created: ${UPDATE_HOOK_REL_PATH}`);
      skillCopied++;
    }

    const result = registerUpdateHook(targetAbs, { overwrite, dryRun });
    const prefix = dryRun ? '[dry-run] Would register' : 'Registered';
    if (result === 'added' || result === 'updated') {
      console.log(`  ${prefix} the update-check hook in ${SETTINGS_REL_PATH}`);
    } else if (result === 'exists') {
      console.log(`  Skipped (exists): update-check hook in ${SETTINGS_REL_PATH}`);
    } else {
      // Don't touch a settings file we can't parse — say how to add it by hand.
      console.log(`  Skipped: could not read ${SETTINGS_REL_PATH} (${result.slice('error: '.length)}).`);
      console.log('    To get the update prompt, add this to its "hooks" → "SessionStart" list:');
      console.log(`    ${JSON.stringify(UPDATE_HOOK_ENTRY)}`);
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
          labelDefs = loadLabels(pkgRoot).filter(([name]) => !(selected.excludedLabels || []).includes(name));
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

  // Lite's release gate is one approver, so make it the person installing —
  // by default for lite, or when asked for; --no-set-approvers opts out.
  const wantApprovers = options.setApprovers === undefined ? bundle === 'lite' : options.setApprovers;
  const approver = wantApprovers ? setReleaseApprover(targetAbs, { dryRun }) : null;

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
  const skillPresentButNotTouched =
    !withSkill && (fs.existsSync(skillPath(targetAbs)) || fs.existsSync(updateHookPath(targetAbs)));
  const cleanInstall =
    workflowsSkipped === 0 &&
    templatesSkipped === 0 &&
    scriptsSkipped === 0 &&
    skillSkipped === 0 &&
    !templatesPresentButNotTouched &&
    !skillPresentButNotTouched;
  if (!dryRun && cleanInstall) {
    const pkgVersion = require(path.join(pkgRoot, 'package.json')).version;
    writeManifest(targetAbs, pkgVersion, bundle, customWorkflows, packs);
  } else if (
    !dryRun &&
    (manifestBundle(priorManifest) !== bundle ||
      JSON.stringify(manifestWorkflows(priorManifest, priorBundle, priorPacks)) !== JSON.stringify(customWorkflows) ||
      JSON.stringify(priorPacks) !== JSON.stringify(packs))
  ) {
    // Not a clean install, so the recorded version stays put — but which
    // bundle this repo is on is its own fact (e.g. an existing lite install
    // that was just filled out to full), and `status` reads it.
    const patched = { ...(priorManifest || {}) };
    if (bundle === DEFAULT_BUNDLE) delete patched.bundle;
    else patched.bundle = bundle;
    if (customWorkflows) patched.workflows = customWorkflows;
    else delete patched.workflows;
    if (packs.length) patched.packs = packs;
    else delete patched.packs;
    fs.mkdirSync(path.dirname(manifestPath(targetAbs)), { recursive: true });
    fs.writeFileSync(manifestPath(targetAbs), JSON.stringify(patched, null, 2) + '\n');
  }

  // Summary
  console.log('');
  if (!dryRun && !cleanInstall && !options.packChange) {
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
    let nextStep;
    if (flavor === 'lite') {
      // Lite: skip steps that are already done, and number what's left.
      nextStep = 1;
      if (labelsCreated === 0) {
        console.log(`  ${nextStep}. Create labels: Actions → Setup Labels → Run workflow`);
        if (labelsSkipReason) console.log(`     (Labels skipped: ${labelsSkipReason})`);
        nextStep++;
      }
      console.log(`  ${nextStep}. Configure the repo variable (Settings → Secrets and variables → Actions):`);
      nextStep++;
      if (approver && (approver.state === 'set' || approver.state === 'exists')) {
        console.log('     - RELEASE_APPROVER: done (see above)');
      } else if (approver && approver.state === 'dry-run') {
        console.log('     - RELEASE_APPROVER: will be set to your GitHub login (unless it is already set)');
      } else {
        console.log('     - RELEASE_APPROVER: your GitHub username (or re-run with --set-approvers)');
      }
      console.log('     No QA approver is needed: comment "approved" on a Production Release issue to ship it.');
    } else {
      console.log('  1. Create labels: Actions → Setup Labels → Run workflow');
      if (labelsSkipReason) console.log(`     (Labels skipped: ${labelsSkipReason})`);
      console.log('  2. Configure repo variables (Settings → Secrets and variables → Actions):');
      console.log('     - RELEASE_APPROVER: GitHub username of release approver');
      console.log('     - QA_APPROVER: GitHub username of QA approver');
      console.log('     - QA_ASSIGNEES: Comma-separated usernames for QA assignment');
      if (workflowSet.includes('telegram-issues')) {
        console.log('  3. Add secrets (optional, for Telegram): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
      } else {
        console.log('  3. Telegram alerts are optional: `npx github-delivery-os add telegram .`, then add the secrets TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
      }
      nextStep = 4;
    }
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
  if (migrationNote) {
    console.log('');
    console.log(migrationNote);
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
function buildUpdateCommand({ hasTemplates, hasSkill, bundle = DEFAULT_BUNDLE }) {
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
    bundle !== DEFAULT_BUNDLE ? `--bundle ${bundle}` : null,
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

// Named subsets of the above. `full` is everything (the default, and what a
// manifest with no `bundle` field means). `lite` is for one-person teams and
// small projects: sprints, tasks, bugs and a release approval, without the
// rolling QA machinery (auto-qa-request, qa-rollup-approval, auto-assign-qa,
// Telegram). A bundle must stay a subset of full.
const BUNDLES = {
  full: { workflows: DEFAULT_WORKFLOWS, scripts: SCRIPTS, templates: TEMPLATES },
  lite: {
    workflows: ['setup-labels', 'sprint-child-creator', 'auto-close-sprint', 'notify-release-approver', 'authorize-deployment'],
    scripts: ['authorize-deployment-verdict', 'auto-close-sprint', 'sprint-child-creator', 'labels'],
    templates: ['config.yml', 'sprint_planning.yml', 'task.yml', 'bug_report.yml', 'production_release_qa_signoff.yml'],
    // Lite's own versions of these (no QA approver, no QA roll-up, plain
    // wording), shipped under .github/lite/ and installed under the same names.
    // Full is never touched by them.
    liteWorkflows: ['authorize-deployment', 'notify-release-approver'],
    liteTemplates: ['production_release_qa_signoff.yml'],
    excludedLabels: ['qa-request', 'qa-rollup'],
  },
};
const LITE_REL_DIR = path.join('.github', 'lite');
const DEFAULT_BUNDLE = 'full';

// The bundle a manifest records; anything missing or unrecognised is full.
function manifestBundle(manifest) {
  return manifest && Object.prototype.hasOwnProperty.call(BUNDLES, manifest.bundle) ? manifest.bundle : DEFAULT_BUNDLE;
}

// What each workflow is for, and which others it does nothing useful without
// (a soft dependency: installing it alone works, it just never has anything to
// act on). Read by --only/--skip warnings and by `list`.
const WORKFLOW_INFO = {
  'sprint-child-creator': { summary: 'Creates one child task issue per feature line when a sprint planning issue opens', needs: [] },
  'auto-close-sprint': { summary: 'Keeps the sprint burn-down and health current, and closes the sprint at 100%', needs: ['sprint-child-creator'] },
  'notify-release-approver': { summary: 'Pings the release approver when a Production Release issue opens', needs: [] },
  'authorize-deployment': { summary: 'Reads approve/decline comments on a Production Release and applies ready-for-deploy / declined', needs: [] },
  'auto-assign-qa': { summary: 'Assigns the QA team to issues labeled qa or qa-request', needs: [] },
  'telegram-issues': { summary: 'Sends Telegram alerts for bugs, QA, sprints, releases and merges', needs: [] },
  'setup-labels': { summary: 'One-time workflow that creates the labels Delivery OS uses', needs: [] },
  'auto-qa-request': { summary: 'Adds each change that reaches main to the rolling QA issue (or files QA Requests)', needs: [] },
  'qa-rollup-approval': { summary: "Applies the QA approver's approve/decline to the rolling QA issue", needs: ['auto-qa-request'] },
};

// The comma-separated names a flag was given, trimmed and de-duplicated.
function parseNameList(value) {
  if (value === undefined || value === null) return null;
  const list = [].concat(value).join(',').split(',').map((n) => n.trim().replace(/\.yml$/, '')).filter(Boolean);
  return [...new Set(list)];
}

// The workflows a repo has when they differ from what its bundle and packs
// give by default (recorded as `workflows` in the manifest after --only/--skip
// or an add/remove of single workflows); null when they follow the default.
function manifestWorkflows(manifest, bundle, packs = []) {
  const recorded = manifest && manifest.workflows;
  if (!Array.isArray(recorded) || recorded.length === 0) return null;
  const kept = WORKFLOWS.filter((wf) => recorded.includes(wf));
  if (kept.length === 0 || sameSet(kept, defaultSet(bundle, packs))) return null;
  return kept;
}

// Whether a set is a choice the person made, for display: opt-in workflows
// (Telegram) being present or absent is not, since a default install leaves
// them out and plenty of repos already have them.
function isCustomSelection(workflows, bundle, packs = []) {
  const strip = (list) => list.filter((wf) => !OPT_IN_WORKFLOWS.includes(wf));
  return !sameSet(strip(workflows), strip(defaultSet(bundle, packs)));
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// The workflows a bundle plus its packs give, in the usual order.
function defaultSet(bundle, packs = []) {
  const base = BUNDLES[bundle].workflows;
  if (bundle !== 'lite' || packs.length === 0) return base;
  const fromPacks = packs.flatMap((p) => PACKS[p].workflows);
  return WORKFLOWS.filter((wf) => base.includes(wf) || fromPacks.includes(wf));
}

// Whether a set includes any of the QA workflows. That is what decides if the
// QA form and QA labels are wanted.
function hasQaWorkflows(workflows) {
  return PACKS.qa.workflows.some((wf) => workflows.includes(wf));
}

// Notes for workflows that do little without another one.
function needsWarnings(workflows) {
  const warnings = [];
  for (const wf of workflows) {
    for (const need of WORKFLOW_INFO[wf].needs) {
      if (!workflows.includes(need)) warnings.push(`${wf} has little to do without ${need}.`);
    }
  }
  return warnings;
}

// Which supporting scripts a set of workflows needs. `flavor` is which version
// of the release workflows is installed ('lite' or 'full'): only the full
// notify workflow runs the roll-up. The flavor's own script list when the set
// is exactly the flavor's own, so a default install is exactly what it was.
function scriptsForWorkflows(flavor, workflows) {
  const base = BUNDLES[flavor];
  if (sameSet(workflows, base.workflows)) return base.scripts;
  const needed = new Set();
  for (const wf of workflows) {
    for (const name of [].concat(REQUIRED_SCRIPT_BY_WORKFLOW[wf] || [])) needed.add(name);
    if (wf === 'setup-labels') needed.add('labels');
    if (wf === 'notify-release-approver' && flavor !== 'lite') {
      for (const name of CONTENT_GATED_SCRIPT_BY_WORKFLOW[wf] || []) needed.add(name);
    }
  }
  return SCRIPTS.filter((name) => needed.has(name));
}

// --only (just these) or --skip (all but these), within the bundle's workflows.
// Returns { workflows } or { error }; with neither flag it returns null workflows.
// On full, the opt-in workflows (Telegram) are known names: --only can pick one,
// and --skip of one is accepted (it's simply not in the default set), so a
// command written before it became opt-in keeps working.
function resolveSelection({ bundle, only, skip }) {
  const base = BUNDLES[bundle].workflows;
  const known = bundle === DEFAULT_BUNDLE ? WORKFLOWS : base;
  if (only && skip) return { error: 'Use --only or --skip, not both.' };
  const named = only || skip;
  if (!named) return { workflows: null };
  if (named.length === 0) return { error: `${only ? '--only' : '--skip'} needs at least one workflow name.` };
  const unknown = named.filter((n) => !known.includes(n));
  if (unknown.length) {
    return { error: `Unknown workflow${unknown.length > 1 ? 's' : ''} for the ${bundle} bundle: ${unknown.join(', ')}. Available: ${known.join(', ')}.` };
  }
  const workflows = only ? known.filter((wf) => only.includes(wf)) : base.filter((wf) => !skip.includes(wf));
  if (workflows.length === 0) return { error: 'That leaves nothing to install.' };
  return { workflows };
}

// Packs: optional pieces a lite install can add later (`add qa`) and drop again
// (`remove qa`) without reinstalling. Only lite has them; full already
// includes everything. The `qa` pack also switches the release flow to the
// two-approver one, because that is what QA sign-off means.
const PACKS = {
  qa: {
    summary: 'QA sign-off: the rolling QA issue, QA approval, QA assignment, the QA Request form, QA labels, and a release that needs a QA approver too',
    workflows: ['auto-qa-request', 'qa-rollup-approval', 'auto-assign-qa'],
    templates: ['qa_request.yml'],
  },
  telegram: {
    summary: 'Telegram alerts for bugs, QA, sprints, releases and merges',
    workflows: ['telegram-issues'],
    templates: [],
  },
};

// The packs a manifest records (known names only; none unless it is lite).
function manifestPacks(manifest, bundle) {
  if (bundle !== 'lite' || !manifest || !Array.isArray(manifest.packs)) return [];
  return Object.keys(PACKS).filter((p) => manifest.packs.includes(p));
}

// Which version of the files the bundles keep different versions of (release
// workflows, release form, labels) a repo gets: lite's, unless it is full or
// has added the qa pack.
function flavorFor(bundle, packs) {
  return bundle === 'lite' && !packs.includes('qa') ? 'lite' : 'full';
}

// Everything a repo is meant to have for a bundle, its packs and an optional
// explicit set of workflows: the one place install, remove and status agree on.
function effectiveFor(bundle, packs, customWorkflows) {
  const base = BUNDLES[bundle];
  const flavor = flavorFor(bundle, packs);
  const workflows = customWorkflows || defaultSet(bundle, packs);
  const qa = hasQaWorkflows(workflows);
  const lite = flavor === 'lite';
  return {
    ...base,
    flavor,
    workflows,
    // The QA Request form comes with any QA workflow; the rest are the bundle's.
    templates: bundle === DEFAULT_BUNDLE || !qa ? base.templates : [...base.templates, ...PACKS.qa.templates],
    scripts: scriptsForWorkflows(flavor, workflows),
    liteWorkflows: lite ? BUNDLES.lite.liteWorkflows : undefined,
    liteTemplates: lite ? BUNDLES.lite.liteTemplates : undefined,
    // Lite leaves the QA labels out, unless a QA workflow is installed that uses them.
    excludedLabels: lite && !qa ? BUNDLES.lite.excludedLabels : undefined,
  };
}

// What a repo is expected to have, from its manifest: the bundle, its packs and
// any explicit set of workflows. Used by status.
function expectedFor(manifest) {
  const bundle = manifestBundle(manifest);
  const packs = manifestPacks(manifest, bundle);
  const custom = manifestWorkflows(manifest, bundle, packs);
  const expected = effectiveFor(bundle, packs, custom);
  return { bundle, packs, expected, custom: Boolean(custom) && isCustomSelection(expected.workflows, bundle, packs) };
}

// What can be installed: the bundles, packs and each workflow (what it does,
// which bundles carry it, what it needs) and, when run inside a repo that has
// Delivery OS, which of them are installed there. `--json` is for tools such as
// the setup skill, so they never hard-code this.
function runList({ json = false, targetDir = '.' } = {}) {
  const targetAbs = path.resolve(process.cwd(), targetDir);
  const present = WORKFLOWS.filter((wf) => fs.existsSync(path.join(targetAbs, '.github', 'workflows', `${wf}.yml`)));
  const installed = present.length > 0 ? present : null;
  const packState = (def) => {
    if (!installed) return null;
    const have = def.workflows.filter((wf) => installed.includes(wf)).length;
    return have === def.workflows.length ? 'installed' : have === 0 ? 'available' : 'partly installed';
  };

  const workflows = WORKFLOWS.map((name) => ({
    name,
    summary: WORKFLOW_INFO[name].summary,
    needs: WORKFLOW_INFO[name].needs,
    bundles: Object.keys(BUNDLES).filter((b) => BUNDLES[b].workflows.includes(name)),
    ...(installed ? { installed: installed.includes(name) } : {}),
  }));
  const bundles = {};
  for (const [name, def] of Object.entries(BUNDLES)) {
    bundles[name] = { workflows: def.workflows, templates: def.templates };
  }
  const packs = {};
  for (const [name, def] of Object.entries(PACKS)) {
    packs[name] = { summary: def.summary, workflows: def.workflows, templates: def.templates, ...(installed ? { state: packState(def) } : {}) };
  }
  if (json) {
    console.log(JSON.stringify({ bundles, packs, workflows, installed }, null, 2));
    return;
  }
  console.log('Bundles:');
  console.log('  full  everything (the default)');
  console.log('  lite  one person or a small project: sprints, tasks, bugs and a single-approver release');
  console.log('');
  console.log('Packs (named groups: `add <pack>` to add one, `remove <pack>` to take it away):');
  for (const [name, def] of Object.entries(PACKS)) {
    console.log(`  ${name.padEnd(10)} ${def.summary}${installed ? `  [${packState(def)}]` : ''}`);
  }
  console.log('');
  console.log('Workflows (add or remove any one by name; or choose with --only a,b / --skip a,b at install):');
  for (const w of workflows) {
    const mark = installed ? (w.installed ? '✓ ' : '○ ') : '';
    const where = w.bundles.length ? w.bundles.join(', ') : 'opt-in: add it';
    const needs = w.needs.length ? ` (works with: ${w.needs.join(', ')})` : '';
    console.log(`  ${mark}${w.name.padEnd(24)} [${where}]  ${w.summary}${needs}`);
  }
  if (installed) console.log('\n✓ installed here   ○ not installed');
}

// `add` / `remove`: change what is installed, by pack (a named group) or by
// single workflow. Issue templates and labels follow what the repo already has:
// a form is copied (or removed with what needs it) only if the repo uses the
// forms, and labels are created only with --with-labels.
function change(kind, { targetDir = '.', names, withLabels = false, dryRun = false }) {
  const targetAbs = path.resolve(process.cwd(), targetDir);
  const usesTemplates = BUNDLES.lite.templates.some((t) => fs.existsSync(path.join(targetAbs, '.github', 'ISSUE_TEMPLATE', t)));
  runInstall({
    targetDir,
    [kind === 'add' ? 'addNames' : 'removeNames']: names,
    withTemplates: usesTemplates,
    withLabels,
    dryRun,
    setApprovers: false,
    packChange: true, // skipping what is already there is normal here, not a half-done install
  });
}
function runAdd(options) {
  change('add', options);
}
function runRemove(options) {
  change('remove', options);
}

async function runStatus(options) {
  const { targetDir = '.', checkUpdates = true } = options;
  const targetAbs = path.resolve(process.cwd(), targetDir);
  const workflowsDest = path.join(targetAbs, '.github', 'workflows');
  const templatesDest = path.join(targetAbs, '.github', 'ISSUE_TEMPLATE');

  console.log('=== GitHub Delivery Operating System — Status ===');
  console.log(`Target: ${targetAbs}`);
  console.log('');

  // What this repo is meant to have: the bundle its manifest records (full if
  // none). Anything outside it isn't "missing" or "broken".
  const { bundle, packs, expected: expectedFromManifest, custom } = expectedFor(readManifest(targetAbs));
  // An opt-in workflow already installed on a plain full install counts as expected.
  let expected = expectedFromManifest;
  if (bundle === 'full' && !custom) {
    const extra = OPT_IN_WORKFLOWS.filter((wf) => !expected.workflows.includes(wf) && fs.existsSync(path.join(workflowsDest, `${wf}.yml`)));
    if (extra.length) expected = { ...expected, workflows: WORKFLOWS.filter((wf) => expected.workflows.includes(wf) || extra.includes(wf)) };
  }

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
      const missing = requiredScriptsFor(targetAbs, wf)
        .filter((name) => expected.scripts.includes(name))
        .map((name) => `${name}.js`)
        .filter((file) => !fs.existsSync(path.join(targetAbs, '.github', 'scripts', file)));
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
    return requiredScriptsFor(targetAbs, wf).some((name) => expected.scripts.includes(name));
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
        `  Run: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled, bundle })}`
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
          `    Run: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled, bundle })}`
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
      `  Fix: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled, bundle })}`
    );
    console.log('');
  }

  if (scriptsPkgJsonMissing) {
    console.log(`⚠️  .github/scripts/${SCRIPTS_PACKAGE_JSON} is missing.`);
    console.log('  If this repo\'s own package.json has "type": "module", every workflow that');
    console.log('  require()s a script under .github/scripts will fail with "module is not');
    console.log('  defined in ES module scope" the next time it runs.');
    console.log(
      `  Fix: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: skillInstalled, bundle })}`
    );
    console.log('');
  }

  if (installedTemplates.length > 0) {
    console.log('Templates:');
    installedTemplates.forEach((t) => console.log(`  ✓ ${t}`));
    console.log('');
  }

  const missingWorkflows = expected.workflows.filter((wf) => !installedWorkflows.includes(wf));
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
    if (skillInstalled) {
      const hookReady = fs.existsSync(updateHookPath(targetAbs)) && hasUpdateHookRegistered(targetAbs);
      console.log(
        hookReady
          ? '  ✓ update-check hook (offers updates when a session starts)'
          : `  ○ update-check hook (not set up — run: ${buildUpdateCommand({ hasTemplates: installedTemplates.length > 0, hasSkill: true, bundle })})`
      );
    }
    console.log('');
  }

  if (installedWorkflows.length === 0 && installedTemplates.length === 0 && !skillInstalled) {
    console.log('Delivery OS is not installed in this repository.');
    console.log('Run: npx github-delivery-os install --with-templates --with-labels --with-skill .');
  } else {
    console.log(
      `Summary: ${installedWorkflows.length}/${expected.workflows.length} workflows, ${installedTemplates.length}/${expected.templates.length} templates, skill: ${skillInstalled ? 'yes' : 'no'}`
    );
    if (bundle !== DEFAULT_BUNDLE || custom) {
      console.log(`Bundle: ${bundle}${packs.length ? ` + ${packs.join(', ')}` : ''}${custom ? ' (custom selection)' : ''}`);
    }
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
    const hookDest = updateHookPath(targetAbs);
    if (fs.existsSync(hookDest)) {
      if (dryRun) {
        console.log(`  [dry-run] Would remove: ${UPDATE_HOOK_REL_PATH}`);
      } else {
        fs.unlinkSync(hookDest);
        console.log(`  Removed: ${UPDATE_HOOK_REL_PATH}`);
      }
      skillRemoved++;
    }
    if (unregisterUpdateHook(targetAbs, { dryRun })) {
      console.log(`  ${dryRun ? '[dry-run] Would remove' : 'Removed'}: update-check hook from ${SETTINGS_REL_PATH}`);
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
  const skillRemains = fs.existsSync(skillPath(targetAbs)) || fs.existsSync(updateHookPath(targetAbs));
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
  runList,
  runAdd,
  runRemove,
  TEMPLATES, // also read by src/shell-hook.js
  // Exposed for tests only — not part of the CLI's public API.
  __test__: {
    manifestPath,
    readManifest,
    isOlderVersion,
    rollingQaMigrationNote,
    writeManifest,
    fetchLatestVersion,
    buildUpdateCommand,
    skillPath,
    SKILL_REL_PATH,
    updateHookPath,
    UPDATE_HOOK_REL_PATH,
    SETTINGS_REL_PATH,
    UPDATE_HOOK_ENTRY,
    registerUpdateHook,
    unregisterUpdateHook,
    hasUpdateHookRegistered,
    WORKFLOWS,
    TEMPLATES,
    SCRIPTS,
    SCRIPTS_PACKAGE_JSON,
    LABELS_TSV,
    REQUIRED_SCRIPT_BY_WORKFLOW,
    CONTENT_GATED_SCRIPT_BY_WORKFLOW,
    setupLabelsMissingFiles,
    loadLabels,
    BUNDLES,
    manifestBundle,
    resolveSelection,
    parseNameList,
    manifestWorkflows,
    scriptsForWorkflows,
    WORKFLOW_INFO,
    skillForBundle,
    SKILL_ANCHOR,
    PACKS,
    manifestPacks,
    flavorFor,
    effectiveFor,
    defaultSet,
    sameSet,
    hasQaWorkflows,
    isCustomSelection,
    needsWarnings,
    DEFAULT_WORKFLOWS,
    OPT_IN_WORKFLOWS,
  },
};
