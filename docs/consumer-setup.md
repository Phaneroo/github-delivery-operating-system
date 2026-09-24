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

### Getting told when an update is out

You don't have to remember to run `status`. Two opt-in prompts compare `.github/delivery-os.json` with the latest release and speak up only when the repo is behind:

- **In Claude Code** — installed with `--with-skill`. A SessionStart hook (`.claude/hooks/delivery-os-update-check.js`, registered in `.claude/settings.json` next to any settings you already have) runs when a session starts in the repo. If the install is behind, you see *"Delivery OS 1.8.0 installed, 1.9.0 available"* and Claude offers to run the update command. It only runs it after you say yes, since it rewrites the workflow and template files. Commit both files so everyone on the team gets the prompt; Claude Code runs a project's hooks once the folder is trusted.
- **In your terminal** — any shell session, zsh or bash, no Claude Code needed:

  ```bash
  npx github-delivery-os@latest shell-hook --install     # adds a marked block to ~/.zshrc or ~/.bashrc
  npx github-delivery-os@latest shell-hook --uninstall   # removes it
  npx github-delivery-os@latest shell-hook zsh           # just print the snippet, to add it yourself
  ```

  After that, `cd`-ing into a repo whose install is behind prints a two-line reminder with the update command. It stays quiet as you move around inside the same repo. This one is per person (it lives in your shell startup file), and it can only remind — it never runs anything.

Both are silent when the repo has no manifest, when you're offline, or when anything about the check fails. The latest version is looked up at most once a day and cached in `~/.cache/github-delivery-os/latest-version` (or under `$XDG_CACHE_HOME`), so opening a repo stays instant. The terminal hook refreshes that cache in the background, so a new release shows up on the next `cd` after the refresh.

---

## What Gets Installed

| Workflow | Purpose |
|----------|---------|
| `sprint-child-creator.yml` | Creates child issues when a sprint planning issue (title contains `SPRINT -`) is opened |
| `auto-close-sprint.yml` | Updates burn-down, sprint health; auto-closes sprint when 100% complete |
| `notify-release-approver.yml` | Pings release approver when a production release issue is opened, and posts a roll-up of what's in the release |
| `authorize-deployment.yml` | Dual approval (release approver + QA) before deployment |
| `auto-assign-qa.yml` | Assigns QA team to issues with `qa` or `qa-request` label |
| `auto-qa-request.yml` | QA reminder whenever work reaches `main` (a safety net, not a gate). By default it adds a line to the one **rolling QA issue**; in `per-change` mode it files a QA Request (plus a Task if nothing is linked) per PR or direct push. Docs/settings-only changes are skipped |
| `qa-rollup-approval.yml` | Applies the QA approver's approve/decline (comment or checkbox) to the rolling QA issue |
| `telegram-issues.yml` | Sends Telegram alerts for bugs, QA, sprints, releases, PR merges |
| `setup-labels.yml` | One-time workflow to create all required labels |

With `--with-skill`, also: `.claude/skills/delivery-ops/SKILL.md` — a [Claude Code](https://claude.com/claude-code) skill for operating this repo's Delivery OS from Claude Code (creating sprint/release/QA/bug/task issues in the shape these workflows parse, commenting as an approver with the right keyword conventions, checking status, running autonomous task tracking — identifying and filing tasks/bugs, grouping them into phases via sprints, maintaining a roadmap issue, and updating/closing issues as work progresses — turning a spec/SRS/feature description into a full phase-and-task breakdown filed as real issues, and running a cleanup sweep that finds stale/orphaned/inconsistent issues and roadmap drift for confirmation before touching anything). Optional — most repos aren't using Claude Code, so this isn't written unless asked for. It comes with `.claude/hooks/delivery-os-update-check.js` and an entry in `.claude/settings.json` that registers it, which together offer the update when a session starts in an out-of-date repo (see [Getting told when an update is out](#getting-told-when-an-update-is-out)).

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
| `DELIVERY_OS_AUTO_QA_MODE` | Optional; how `auto-qa-request` reminds QA: `rolling` (default, one open rolling QA issue), `per-change` (the pre-1.9.0 behavior: one QA Request + Task per change), or `off` |
| `DELIVERY_OS_AUTO_QA` | Optional; the 1.8.0 setting, still honored when `DELIVERY_OS_AUTO_QA_MODE` is unset: `all` → per-change, `pr-only` → **rolling**, with direct pushes adding nothing (PRs still do; set `DELIVERY_OS_AUTO_QA_MODE=per-change` too to keep a QA Request per PR), `off` → nothing is filed |
| `DELIVERY_OS_AUTO_TASK` | Optional, per-change mode only; set to `false` so a direct push with no linked issue files only a QA Request, without a synthetic backing Task. PRs are unaffected. (Rolling mode never files a Task) |
| `DELIVERY_OS_AUTO_QA_QUIET_PATHS` | Optional; comma-separated globs whose changes alone file nothing. Unset = docs and settings (`**/*.md`, `docs/**`, `LICENSE*`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.vscode/**`, `.idea/**`, `.github/ISSUE_TEMPLATE/**`, `.github/CODEOWNERS`, `.github/dependabot.yml`); a list replaces those defaults; `none` files for every change |
| `DELIVERY_OS_AUTO_CLOSE` | Optional; set to `false` to stop `authorize-deployment` closing auto-filed issues when a release is authorized |

#### Rolling QA issue (default)

Since 1.9.0, `auto-qa-request` keeps **one** open QA issue per repo instead of filing a QA Request (and often a Task) for every change:

- **Adding changes.** When a direct push lands on `main`, or a PR is merged into `main` (recorded from that push, so fork PRs and merge, squash and rebase merges all count, and PRs merged into other branches don't), the rolling issue *QA REQUEST - Changes awaiting QA* (labels `qa-request`, `delivery-ops-filed`, `qa-rollup`) gets a checklist line: `- [ ] <title> (<short sha or #PR>) by @author`, plus `— for #N` when the change links an issue (`Closes #N`, `Refs #N`, `#N`). Under each line is a plain-English draft built from its commits, which devs can edit. If no rolling issue is open, the first change opens one. The same commit or PR is never added twice. Docs/settings-only changes and `[skip qa-request]` pushes add nothing. PRs are added when they reach `main`, not when they open. A commit author with no GitHub account is named without an `@`.
- **No synthetic Tasks.** The rolling issue is the paper trail, so direct pushes don't create a Task.
- **Approving (QA approver only).** The approver can:
  - comment starting with any of `qa approved`, `approved`, `qa ok`, `looks good`, `lgtm`, `all good`, `good to go`, `ship it` (anything may follow), or just `ok`, `approve`, `tested` or `passed` as the whole comment ("Tested!" counts; "Ok, I'll test tomorrow" doesn't), case-insensitive, or
  - comment starting with ✅, 👍 or ✔️, or
  - tick the **Approved: all changes above have been tested** box at the bottom of the issue.

  Approval ticks every line, sets QA Outcome to *Pass*, closes the issue as completed and posts a summary of what it covered. The next change opens a fresh rolling issue.
- **Declining (QA approver only).** The approver comments starting with any of `not approved`, `declined`, `decline`, `rejected`, `reject`, `failed`, `changes needed`, `needs work`, `not ok`, `blocked`, or with ❌, 👎 or 🚫. The issue stays open with QA Outcome *Fail* and an acknowledgement. Fixes pushed afterwards are added to the same list, and a later approval closes it.
- **Rules.** Decline phrases are checked first, so `not approved` is never read as `approved`. Phrases must *start* the comment and match whole words (`okay` isn't `ok`). The approver's latest verdict wins: a decline after an approval reopens the issue (or points to the newer rolling issue if one has started). Approve/decline comments or box ticks from anyone else are ignored with a short reply, and a ticked box is unticked. Ordinary discussion is left alone.
- **Emoji reactions don't count.** GitHub Actions can't trigger on reactions, so the emoji has to be in a comment.
- **Release roll-up.** A Production Release's *What's in this release* comment lists the rolling-issue lines that belong to it, each with its QA status: lines added before the release was requested, and since the previous release (or still awaiting QA). Lines added after the request are counted but not listed.
- **Switching back.** Set `DELIVERY_OS_AUTO_QA_MODE=per-change` (or keep `DELIVERY_OS_AUTO_QA=all`) for one QA Request per change. Set it to `off` to file nothing. A repo that had `DELIVERY_OS_AUTO_QA=pr-only` moves to the rolling issue with PRs only; add `DELIVERY_OS_AUTO_QA_MODE=per-change` to keep a QA Request per PR.
- **Upgrading from 1.8.x.** Existing open auto-filed QA Requests are left as they are; nothing is mass-closed. The delivery-ops skill's cleanup sweep can propose closing old leftovers. Run *Setup Labels* (or `--with-labels`) to create the `qa-rollup` label.

The phrase and emoji lists live in `.github/scripts/authorize-deployment-verdict.js`, a module shared with `authorize-deployment`. The release gate uses the same matching rules but keeps its own shorter vocabulary.

#### Tuning `auto-qa-request` for direct-push repos

These apply in both modes. In rolling mode they decide what goes on the rolling issue's list; in per-change mode they decide what gets its own QA Request (plus a Task if nothing is linked):

- **Link the push to an issue in its commit message.** `Closes #27`, `Refs #27`, or a bare `#27` in any commit of the push links the change to #27 (on its rolling line, or as the per-change QA Request's related issue), and no new Task is filed. (References to pull requests, other repos, or issues that don't exist are ignored.)
- **Skip a trivial push** by putting `[skip qa-request]` in its commit message. It opts out that commit, not the whole push: a push is skipped only when every commit in it is marked, so a marked typo fix can't hide real changes pushed with it. Only this workflow honors it — `[skip ci]` would skip every workflow.
- **Docs- and settings-only changes file nothing.** A push or PR that only touches paths matching `DELIVERY_OS_AUTO_QA_QUIET_PATHS` (README edits, `docs/`, editor config…) is skipped. Anything else — code, workflows, `package.json` — still files.
- **Turn it down repo-wide** with `DELIVERY_OS_AUTO_QA_MODE` / `DELIVERY_OS_AUTO_QA` / `DELIVERY_OS_AUTO_TASK` above. These are repo variables, not workflow edits, so `install --update` keeps them.

#### Plain-English changelog on every QA Request

In rolling mode, each change's line carries its plain-English draft as indented bullets. Devs edit those in place, and the QA approver's approval covers the whole list; there's no per-change review box. The rest of this section is about per-change QA Requests.

Every per-change QA Request, whether filed by hand or by `auto-qa-request`, has a **What Changed (plain English)** section and a **Changelog Review** checkbox. The workflow seeds a draft from the PR's or push's commit subjects, marked as a draft. The developer who made the change rewrites it in plain English (what a user will notice, and what could break) and ticks the box, so QA knows what to test and that the description is trustworthy. The `delivery-ops` skill can write the plain-English version from the diff and flags unreviewed changelogs in its status check and cleanup sweep, but it never ticks the box itself.

Those notes are collected again when a release is requested: the Production Release issue gets a **What's in this release** roll-up comment listing each QA Request's notes and whether they're dev-reviewed, so approvers see what they're signing off. See [governance.md](governance.md#production-release).

#### When auto-filed issues get closed

`auto-qa-request` only ever closes what it filed itself (identified by its footer and the `delivery-ops-filed` label) — never an issue a person filed:

- **PR closed without merging** → its auto-filed Task and QA Request are closed as *not planned*, with a comment. **Reopening the PR reopens them.**
- **Release authorized** (`authorize-deployment` adds `ready-for-deploy`) → every open auto-filed Task and QA Request created *before that release issue was opened* is closed as *completed* — except ones whose PR hasn't merged yet, which stay open for the release that ships them —, with a comment pointing at the release, and the release issue gets a summary comment. Opt out with `DELIVERY_OS_AUTO_CLOSE=false`.

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

This removes the nine workflow files, optionally the issue templates and the Claude Code skill (with its update-check hook and its entry in `.claude/settings.json`, leaving your other settings alone), and `.github/delivery-os.json` if present. It does not touch repo variables or secrets. Templates and the skill are both kept by default — pass the matching flag to remove each.

**Manual alternative** — delete these files from `.github/workflows/`:
- `sprint-child-creator.yml`
- `auto-close-sprint.yml`
- `notify-release-approver.yml`
- `authorize-deployment.yml`
- `auto-assign-qa.yml`
- `auto-qa-request.yml`
- `qa-rollup-approval.yml`
- `telegram-issues.yml`
- `setup-labels.yml`

Optionally also remove templates from `.github/ISSUE_TEMPLATE/`, `.github/delivery-os.json`, and repo variables/secrets.
