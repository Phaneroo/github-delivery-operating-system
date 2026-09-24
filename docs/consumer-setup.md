# Consumer Setup Guide

This guide explains how to install the Delivery Operating System into your repository. Workflows and templates are **copied directly** into your repo. No `workflow_call` or external references.

---

## ⚠️ Which Command to Use?

| Situation | Command | What happens |
|-----------|---------|--------------|
| **New repo** (no Delivery OS yet) | `./scripts/install.sh --with-templates /path/to/repo` | Installs all workflows and templates |
| **Repo with existing workflows/templates** (yours + others) | `./scripts/install.sh --with-templates /path/to/repo` | Adds only *missing* Delivery OS files. **Your existing files are NOT touched.** |
| **Update Delivery OS** (get latest fixes) | `./scripts/install.sh --with-templates --with-labels --update /path/to/repo` | **Replaces** Delivery OS workflows/templates and syncs labels (creates any new ones a release added — safe to re-run, existing labels are left alone). Your *other* workflows (different names) stay intact. |
| **Preview before installing** | `./scripts/install.sh --with-templates --dry-run /path/to/repo` | Shows what would be copied. No files changed. |

**Warning:** `--update` replaces only Delivery OS files (same names). It does **not** delete your other workflows or templates. Use `--dry-run` first if unsure.

---

## Installation

**One command (recommended):**

```bash
npx github-delivery-os install --with-templates .
```

From your repo root. Add `--with-labels` to create labels via `gh` CLI.

**Alternative — from the `github-delivery-operating-system` repo root:**

```bash
# Copy workflows only
./scripts/install.sh /path/to/your-repo

# Copy workflows + issue templates (required for sprint child creation)
./scripts/install.sh --with-templates /path/to/your-repo

# Copy workflows + templates + create labels via gh CLI
./scripts/install.sh --with-templates --with-labels /path/to/your-repo

# Update existing install (replace workflows and templates, sync labels)
./scripts/install.sh --with-templates --with-labels --update /path/to/your-repo

# Preview what would happen (no files changed)
./scripts/install.sh --with-templates --dry-run /path/to/your-repo

# Explicitly skip existing (same as default)
./scripts/install.sh --no-update /path/to/your-repo
```

**CLI options (with `npx github-delivery-os install`):**

| Flag | Description |
|------|-------------|
| `-t, --with-templates` | Copy issue templates |
| `-l, --with-labels` | Create labels via `gh` CLI |
| `-s, --with-skill` | Add the `delivery-ops` Claude Code skill |
| `-u, --update` | Replace existing files |
| `-d, --dry-run` | Preview without changing files |

**Options:**

| Flag | Description |
|------|-------------|
| `--with-templates` | Copy issue templates (sprint, task, bug, QA, production release) |
| `--with-labels` | Create labels via `gh` CLI (requires `gh auth` and GitHub remote) |
| `--with-skill` | Add `.claude/skills/delivery-ops/SKILL.md` — a Claude Code skill scoped to this repo for creating issues, commenting as an approver, and checking status |
| `--update` | Replace existing workflow/template files |
| `--no-update` | Explicitly skip existing files (default behavior) |
| `--dry-run` | Show what would happen without changing any files |

By default, existing files are **skipped** (never overwritten). Use `--update` to replace. Use `--dry-run` to preview changes safely. (`--overwrite`/`--no-overwrite` still work as hidden aliases from before 1.5.0.)

---

## Checking Status & Updates

```bash
npx github-delivery-os status .            # What's installed, installed version, update check
npx github-delivery-os status --offline .  # Same, without checking npm for the latest version
```

Installing via `npx github-delivery-os` writes `.github/delivery-os.json` — a small manifest recording which version was installed. `status` reads it and, unless `--offline` is passed, checks npm for the latest published version:

- `⬆️  Update available: 1.0.3 → 1.1.0` — a newer release exists; the message includes the exact `install --update` command to run.
- `✓ Up to date` — you're on the latest.
- A quiet note instead, if npm can't be reached — the check never fails the command.

The manifest is only written/updated when the files it describes are actually current on disk (a fresh install, or one run with `--update`). A skip-mode install over pre-existing files leaves it as-is rather than claiming a version that isn't really installed — `status` will tell you when that's happened.

**Note:** this version tracking only applies to the `npx github-delivery-os` install path. The `scripts/install.sh` clone-and-run alternative does not currently write or read this manifest.

---

## What Gets Installed

| Workflow | Purpose |
|----------|---------|
| `sprint-child-creator.yml` | Creates child issues when a sprint planning issue (title contains `SPRINT -`) is opened |
| `auto-close-sprint.yml` | Updates burn-down, sprint health; auto-closes sprint when 100% complete |
| `notify-release-approver.yml` | Pings release approver when a production release issue is opened |
| `authorize-deployment.yml` | Dual approval (release approver + QA) before deployment |
| `auto-assign-qa.yml` | Assigns QA team to issues with `qa` or `qa-request` label |
| `auto-qa-request.yml` | Files a QA Request (and a backing Task, if none is linked) whenever a PR opens or a commit lands directly on `main`, unless only docs/settings changed — a safety net, not a gate. Closes those filings if the PR is closed without merging |
| `telegram-issues.yml` | Sends Telegram alerts for bugs, QA, sprints, releases, PR merges |
| `setup-labels.yml` | One-time workflow to create all required labels |

With `--with-skill`, also: `.claude/skills/delivery-ops/SKILL.md` — a [Claude Code](https://claude.com/claude-code) skill for operating this repo's Delivery OS from Claude Code (creating sprint/release/QA/bug/task issues in the shape these workflows parse, commenting as an approver with the right keyword conventions, checking status, running autonomous task tracking — identifying and filing tasks/bugs, grouping them into phases via sprints, maintaining a roadmap issue, and updating/closing issues as work progresses — turning a spec/SRS/feature description into a full phase-and-task breakdown filed as real issues, and running a cleanup sweep that finds stale/orphaned/inconsistent issues and roadmap drift for confirmation before touching anything). Optional — most repos aren't using Claude Code, so this isn't written unless asked for.

---

## Sprint Child Creation

Child issues are created **automatically** when:

1. An issue is opened with a title containing `SPRINT -` (e.g. `SPRINT - Sprint 12`)
2. The issue body contains a section `### Sprint Features (One Per Line)` with one feature per line

**Required:** Use the `sprint_planning.yml` template (install with `--with-templates`). The template provides the correct form structure.

**Sprint dates:** Enter Sprint Start and Sprint End in YYYY-MM-DD format.

Each line under "Sprint Features" becomes a child issue with `Parent Sprint: #N` in the body.

---

## Configuration

### Repo Variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Description |
|----------|-------------|
| `RELEASE_APPROVER` | GitHub username of release approver (for notify + authorize) |
| `QA_APPROVER` | GitHub username of QA approver (for dual approval) |
| `QA_ASSIGNEES` | Comma-separated usernames for QA auto-assignment (e.g. `user1,user2`) |
| `PROJECT_NAME` | Optional; shown in release approval notifications |
| `DELIVERY_OS_AUTO_QA` | Optional; when `auto-qa-request` files: `all` (default: every PR and direct push to `main`), `pr-only` (PRs only — direct pushes file nothing), or `off` |
| `DELIVERY_OS_AUTO_TASK` | Optional; set to `false` so a direct push with no linked issue files only a QA Request, without a synthetic backing Task. PRs are unaffected |
| `DELIVERY_OS_AUTO_QA_QUIET_PATHS` | Optional; comma-separated globs whose changes alone file nothing. Unset = docs and settings (`**/*.md`, `docs/**`, `LICENSE*`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.vscode/**`, `.idea/**`, `.github/ISSUE_TEMPLATE/**`, `.github/CODEOWNERS`, `.github/dependabot.yml`); a list replaces those defaults; `none` files for every change |
| `DELIVERY_OS_AUTO_CLOSE` | Optional; set to `false` to stop `authorize-deployment` closing auto-filed issues when a release is authorized |

#### Tuning `auto-qa-request` for direct-push repos

Repos that push straight to `main` (common for solo-maintained prototypes) get a QA Request — and, if nothing is linked, a backing Task — on every push. To keep that accurate and quiet:

- **Link the push to an issue in its commit message.** `Closes #27`, `Refs #27`, or a bare `#27` all link the QA Request to #27, and no new Task is filed. (References to pull requests, other repos, or issues that don't exist are ignored.)
- **Skip a trivial push** by putting `[skip qa-request]` anywhere in its commit message. Only this workflow honors it — `[skip ci]` would skip every workflow.
- **Docs- and settings-only changes file nothing.** A push or PR that only touches paths matching `DELIVERY_OS_AUTO_QA_QUIET_PATHS` (README edits, `docs/`, editor config…) is skipped. Anything else — code, workflows, `package.json` — still files.
- **Turn it down repo-wide** with `DELIVERY_OS_AUTO_QA` / `DELIVERY_OS_AUTO_TASK` above. These are repo variables, not workflow edits, so `install --update` keeps them.

#### When auto-filed issues get closed

`auto-qa-request` only ever closes what it filed itself (identified by its footer and the `delivery-ops-filed` label) — never an issue a person filed:

- **PR closed without merging** → its auto-filed Task and QA Request are closed as *not planned*, with a comment.
- **Release authorized** (`authorize-deployment` adds `ready-for-deploy`) → every open auto-filed Task and QA Request created *before that release issue was opened* is closed as *completed*, with a comment pointing at the release, and the release issue gets a summary comment. Opt out with `DELIVERY_OS_AUTO_CLOSE=false`.

Repos that never cut a Production Release (e.g. push-to-`main` prototypes) have no release event to close on — the `delivery-ops` skill's cleanup sweep flags those leftovers for you to confirm instead.

Note: a direct-push commit whose first line ends in `(#N)` looks like a squash-merged PR and is skipped, since that PR's own `pull_request` event already filed for it.

### Secrets (optional)

| Secret | Used By |
|--------|---------|
| `TELEGRAM_BOT_TOKEN` | telegram-issues, auto-close-sprint |
| `TELEGRAM_CHAT_ID` | telegram-issues, auto-close-sprint |

### Telegram Alerts

1. Create a bot via [@BotFather](https://t.me/BotFather); copy the token.
2. Start a chat with your bot or add it to a group/channel.
3. Get the chat ID: send a message, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`.
4. Add both secrets in **Settings → Secrets and variables → Actions**.

Alerts are sent for: bugs, QA requests, sprints, production releases, PR merges to main. If secrets are not set, the workflow skips sending (no error).

---

## Required Labels

Run **Actions → Setup Labels → Run workflow** once, or use `--with-labels` when installing (requires `gh` CLI).

The current list of labels (names, colors, descriptions) lives in [`.github/scripts/labels.tsv`](https://github.com/Phaneroo/github-delivery-operating-system/blob/main/.github/scripts/labels.tsv) — the single source of truth `setup-labels.yml`, `scripts/install.sh`, and `src/install.js` all read, so it's never out of sync with what actually gets created. (Absolute URL, not a relative link: this page is also published to GitHub Pages from just the `docs/` directory, where `.github/` doesn't exist — a relative `../.github/...` link would 404 there even though it resolves fine when browsing the repo directly on GitHub.com.) This doc used to carry its own copy of that table; dropped it rather than risk it silently going stale the next time a label changes ([#20](https://github.com/Phaneroo/github-delivery-operating-system/issues/20) was filed for exactly that class of drift).

**Upgrading from before 1.5.0:** sprint child issues were previously labeled `sprint-active`. New child issues use `sprint-child` instead; existing issues keep whatever label they already have (nothing renames it for you). To unify an existing repo onto the new name — this retroactively relabels every issue that already has it, no per-issue edits needed:

```
gh label edit sprint-active --repo <owner>/<repo> --name sprint-child
```

**Upgrading from before the `delivery-ops-filed` label:** issues `auto-qa-request` (or the `delivery-ops` Claude Code skill's autonomous tracking) filed before this label existed don't get it retroactively just because the repo updates — the update only changes what *future* runs do. To backfill it onto everything already auto-filed, found by the "Auto-filed by Delivery OS" footer line every such issue carries:

```
gh issue list --repo <owner>/<repo> --search "\"Auto-filed by Delivery OS\" in:body" --json number --jq '.[].number' \
  | xargs -I{} gh issue edit {} --repo <owner>/<repo> --add-label delivery-ops-filed
```

---

## Issue Templates (with `--with-templates`)

| Template | Purpose |
|----------|---------|
| `sprint_planning.yml` | Sprint planning; each feature line → child issue |
| `task.yml` | Structured task with priority, status, acceptance criteria |
| `qa_request.yml` | QA testing request |
| `production_release_qa_signoff.yml` | Production release + QA sign-off |
| `bug_report.yml` | Bug report with platform, severity, steps |

---

## Troubleshooting

### "Resource not accessible by integration" when creating issues

The consumer repo must allow workflows to write. In your consumer repo:

1. Go to **Settings** → **Actions** → **General**
2. Under **Workflow permissions**, select **Read and write permissions**
3. Save

---

## Uninstalling

**One command (recommended):**

```bash
npx github-delivery-os uninstall .                    # Remove workflows only
npx github-delivery-os uninstall --with-templates .   # Also remove issue templates
npx github-delivery-os uninstall --with-skill .       # Also remove the delivery-ops Claude Code skill
npx github-delivery-os uninstall --dry-run .          # Preview (no changes)
```

This removes the eight workflow files, optionally the issue templates and the Claude Code skill, and `.github/delivery-os.json` if present. It does not touch repo variables or secrets. Templates and the skill are both kept by default — pass the matching flag to remove each.

**Manual alternative** — delete these files from `.github/workflows/`:
- `sprint-child-creator.yml`
- `auto-close-sprint.yml`
- `notify-release-approver.yml`
- `authorize-deployment.yml`
- `auto-assign-qa.yml`
- `auto-qa-request.yml`
- `telegram-issues.yml`
- `setup-labels.yml`

Optionally also remove templates from `.github/ISSUE_TEMPLATE/`, `.github/delivery-os.json`, and repo variables/secrets.
