const fs = require('fs');
const os = require('os');
const path = require('path');

// `delivery-os setup-skill`: puts the delivery-os-setup Claude Code skill (the
// one that helps you choose what to install) where Claude Code can find it.
// By default that's your user-level skills folder, so it works in any repo —
// including one that has no Delivery OS yet, which is the whole point. With
// --project it goes into the current repo's .claude/skills instead.

const SKILL_NAME = 'delivery-os-setup';
const SKILL_SRC = path.join('skills', SKILL_NAME, 'SKILL.md');

function runSetupSkill({ project = false, update = false, dryRun = false, homeDir = os.homedir(), cwd = process.cwd() } = {}) {
  const pkgRoot = path.join(__dirname, '..');
  const src = path.join(pkgRoot, SKILL_SRC);
  const base = project ? path.join(cwd, '.claude', 'skills') : path.join(homeDir, '.claude', 'skills');
  const dest = path.join(base, SKILL_NAME, 'SKILL.md');
  const shown = project ? path.join('.claude', 'skills', SKILL_NAME, 'SKILL.md') : path.join('~', '.claude', 'skills', SKILL_NAME, 'SKILL.md');

  if (!fs.existsSync(src)) {
    console.error(`The setup skill is missing from this package (${SKILL_SRC}).`);
    process.exitCode = 1;
    return;
  }

  if (fs.existsSync(dest) && !update) {
    const same = fs.readFileSync(dest, 'utf8') === fs.readFileSync(src, 'utf8');
    console.log(same ? `Already installed and up to date: ${shown}` : `Already installed: ${shown} (differs from this version; re-run with --update to replace it)`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] Would ${fs.existsSync(dest) ? 'replace' : 'create'}: ${shown}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`${update ? 'Updated' : 'Added'}: ${shown}`);
  console.log('');
  console.log('Now, in Claude Code, in the repo you want to set up, ask:');
  console.log('  "Set up Delivery OS here" or "Which Delivery OS pieces do I need?"');
}

module.exports = { runSetupSkill, SKILL_NAME, SKILL_SRC };
