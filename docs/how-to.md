# How To Guide

Step-by-step instructions for using the Delivery Operating System after installation.

---

## Install Into Another Repo

### Step 1: Clone Delivery OS

```bash
git clone https://github.com/Phaneroo/github-delivery-operating-system
cd github-delivery-operating-system
```

### Step 2: Run the Installer

```bash
# Recommended: workflows + templates
./scripts/install.sh --with-templates /path/to/your-consumer-repo

# With labels (requires gh CLI, repo on GitHub)
./scripts/install.sh --with-templates --with-labels /path/to/your-consumer-repo
```

### Step 3: Create Labels

**Option A:** Actions → Setup Labels → Run workflow (no token needed)

**Option B:** If you used `--with-labels`, labels were created. Otherwise run Setup Labels from Actions.

### Step 4: Configure Variables

Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
|----------|-------|
| `RELEASE_APPROVER` | GitHub username of release approver |
| `QA_APPROVER` | GitHub username of QA approver |
| `QA_ASSIGNEES` | Comma-separated usernames (e.g. `user1,user2`) |
| `DELIVERY_OS_AUTO_QA_MODE` | Optional: `rolling` (default — one open rolling QA issue), `per-change`, or `off` (see [consumer-setup.md](consumer-setup.md#rolling-qa-issue-default)) |
| `DELIVERY_OS_AUTO_QA` | Optional, 1.8.0 setting still honored: `all` → per-change, `pr-only`, `off` |
| `DELIVERY_OS_AUTO_TASK` | Optional: `false` to stop direct pushes filing a synthetic Task |
| `DELIVERY_OS_AUTO_QA_QUIET_PATHS` | Optional: globs whose changes alone file nothing (default: docs/settings; `none` disables) |
| `DELIVERY_OS_AUTO_CLOSE` | Optional: `false` to stop auto-closing filed issues when a release is authorized |

### Step 5: Commit & Push

```bash
cd /path/to/your-consumer-repo
git add .github/
git commit -m "Install Delivery OS"
git push
```

---

## Create a Sprint

1. Issues → New issue
2. Select **SPRINT PLANNING**
3. Fill in:
   - **Sprint Name:** e.g. Sprint 12 - March 1–14
   - **Sprint Start / Sprint End:** YYYY-MM-DD format
   - **Sprint Goal:** What this sprint achieves
   - **Sprint Features (One Per Line):** One feature per line, no bullets:
     ```
     Implement burn-down chart
     Add sprint health indicator
     Prevent duplicate child creation
     ```
4. Submit

**What happens:** Child issues are created automatically. Each feature line becomes an issue with `Parent Sprint: #N`. Closing child issues updates burn-down; sprint auto-closes at 100%.

---

## Request Production Release

1. Ensure you have a sprint planning issue (e.g. #45)
2. Issues → New issue → **PRODUCTION RELEASE & QA SIGN-OFF**
3. Fill in:
   - **Sprint Reference:** #45
   - **Version / Build Number:** v2.4.1
   - **Release Summary:** What's in this release
   - **QA Summary + Evidence Links:** QA issues, screenshots, logs
   - **Overall QA Recommendation:** Approve / Reject / Conditional
4. Submit

**What happens:** Issue gets `release`, `production`, `approval` labels. Release approver is notified. For dual approval, both `RELEASE_APPROVER` and `QA_APPROVER` must comment approval.

---

## Approve a Release

**Single approval:** Release approver comments `approved`, `approve`, or `ok` on the production release issue.

**Dual approval:** Both must comment:
- Release approver: `approved`, `approve`, `ok`, or `go ahead`
- QA approver: `qa approved`, `approved`, `qa ok`, or `looks good`

Once both approve, the issue receives `ready-for-deploy`. To decline, release approver comments `declined`, `reject`, or `not approved`.

---

## Report a Bug

1. Issues → New issue → **Bug Report**
2. Fill in platform, severity, build, steps, expected/actual result
3. Submit

**What happens:** Issue gets `bug` and `qa` labels.

---

## Request QA Testing

1. Issues → New issue → **QA REQUEST**
2. Fill in related issue (#), **What Changed (plain English)**, what to test, environment, acceptance criteria
3. The developer who made the change ticks **Changelog Review** once the What Changed section is accurate
4. Submit

**What happens:** Issue gets `qa-request` label. If `QA_ASSIGNEES` is set, those users are assigned.

**Writing What Changed:** one bullet per change a user could notice, described the way they'd experience it ("The login page now remembers your email"), with no file, function or library names. End with a `Could affect:` line naming nearby features worth re-checking. QA uses this to decide what to test, so it should make sense to someone who never reads the code. Auto-filed QA Requests start with a draft built from commit messages; the dev rewrites it (or asks the `delivery-ops` skill to) and ticks the box.

---

## Approve or Decline the Rolling QA Issue

By default, changes that reach `main` collect on one open issue, **QA REQUEST - Changes awaiting QA** (label `qa-rollup`). Test the listed changes, then, as the `QA_APPROVER`:

- **Approve:** comment starting with `approved`, `lgtm`, `looks good`, `tested`, `ship it`, ✅, 👍 (or any phrase from [the full list](consumer-setup.md#rolling-qa-issue-default)), or tick **Approved: all changes above have been tested**. The issue closes with a summary, and the next change opens a fresh one.
- **Decline:** comment starting with `declined`, `needs work`, `not ok`, `failed`, ❌, 👎 (or any phrase from the full list). The issue stays open, and fixes pushed afterwards are added to it. Approve once they're tested.

A comment from anyone else is ignored with a short reply. Emoji *reactions* don't count; put the emoji in a comment.

---

## Enable Telegram Alerts

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
3. Settings → Secrets and variables → Actions → Secrets
4. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`

Alerts are sent for: bugs, QA requests, sprints, production releases, PR merges to main.

---

## Uninstall

**Option A — CLI (recommended):**
```bash
npx github-delivery-os uninstall .                    # Remove workflows only
npx github-delivery-os uninstall --with-templates .    # Remove workflows + templates
npx github-delivery-os uninstall --with-skill .        # Also remove the delivery-ops Claude Code skill
npx github-delivery-os uninstall --dry-run .           # Preview
```

**Option B — Manual:**
1. Delete from `.github/workflows/`:
   - `sprint-child-creator.yml`
   - `auto-close-sprint.yml`
   - `notify-release-approver.yml`
   - `authorize-deployment.yml`
   - `auto-assign-qa.yml`
   - `auto-qa-request.yml`
   - `qa-rollup-approval.yml`
   - `telegram-issues.yml`
   - `setup-labels.yml`
2. Optionally remove templates from `.github/ISSUE_TEMPLATE/`
3. Optionally remove repo variables and secrets
4. Commit and push

---

## Approver Keywords

| Approver | Approve | Decline |
|----------|---------|---------|
| Release | `approved`, `approve`, `ok`, `go ahead` | `declined`, `reject`, `not approved` |
| QA | `qa approved`, `approved`, `qa ok`, `looks good` | — |

---

## Template Reference

| Template | Auto-labels | Purpose |
|----------|-------------|---------|
| SPRINT PLANNING | sprint, planning | Each feature line → child issue |
| Task | task | Priority, status, acceptance criteria |
| Bug Report | bug, qa | Platform, severity, steps |
| QA REQUEST | qa-request | Related issue, what to test |
| PRODUCTION RELEASE & QA SIGN-OFF | release, production, approval | Sprint ref, version, QA recommendation |

---

## Quick Reference

| Task | Action |
|------|--------|
| Install | `./scripts/install.sh --with-templates /path/to/repo` |
| Update install | Add `--update` |
| Create sprint | New issue → SPRINT PLANNING |
| Request release | New issue → PRODUCTION RELEASE & QA SIGN-OFF |
| Approve release | Comment `approved` (dual: both approvers) |
| Report bug | New issue → Bug Report |
| QA request | New issue → QA REQUEST |
| Enable Telegram | Add TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID |
| Uninstall | Delete workflow files |
