# GitHub Delivery Operating System

> A GitHub-native Delivery Governance Framework for structured sprint execution, QA review, and collaborative production release control.

[![Socket Badge](https://badge.socket.dev/npm/package/github-delivery-os)](https://socket.dev/npm/package/github-delivery-os)

---

## Why This Exists

Engineering teams often rely on informal coordination inside GitHub — manual approvals, inconsistent sprint tracking, reactive QA engagement, and socially enforced production releases.

As teams scale, this creates:

* Delivery ambiguity
* QA bottlenecks
* Unclear accountability
* Release risk
* Cross-team misalignment

The **GitHub Delivery Operating System (Delivery OS)** embeds structured intake, sprint orchestration, QA governance, and collaborative release gates directly into engineering repositories — without replacing CI/CD pipelines or disrupting developer workflows.

---

## Installation

**One command** (recommended):

```bash
npx github-delivery-os install --with-templates .
```

From your repo root. Add `--with-labels` to create labels via `gh` CLI (requires `gh auth`). Add `--with-skill` to also drop in a [Claude Code](https://claude.com/claude-code) skill for operating this repo's Delivery OS from Claude Code — creating sprint/release/QA issues, commenting as an approver, checking status. Use `--dry-run` to preview first.

**Alternative — clone and run script:**

```bash
git clone https://github.com/Phaneroo/github-delivery-operating-system
cd github-delivery-operating-system

# New install or repo with existing workflows — adds only missing files (safe)
./scripts/install.sh --with-templates /path/to/your-repo

# Also create labels via gh CLI (requires gh auth)
./scripts/install.sh --with-templates --with-labels /path/to/your-repo

# Update Delivery OS (replace existing) — use --dry-run first to preview
./scripts/install.sh --with-templates --overwrite /path/to/your-repo
```

**Note:** By default, existing files are **never overwritten**. Use `--overwrite` only when updating Delivery OS. See [Consumer Setup](docs/consumer-setup.md) for the full command guide.

**Other commands:**
```bash
npx github-delivery-os status .                    # Show what's installed + installed version
npx github-delivery-os status --offline .          # Same, without checking npm for updates
npx github-delivery-os uninstall .                 # Remove workflows
npx github-delivery-os uninstall --with-templates .  # Remove workflows + templates
npx github-delivery-os uninstall --dry-run .      # Preview (no changes)
```

`status` also checks npm for a newer release and tells you if you're behind (e.g. `⬆️ Update available: 1.0.3 → 1.1.0`), along with the exact command to update. That check is silent and non-fatal if you're offline — use `--offline` to skip it outright (e.g. in CI).

**What gets installed:**

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `sprint-child-creator` | Issue opened, title contains `SPRINT -` | Parses "Sprint Features (One Per Line)" and creates one child issue per line, each linked back with `Parent Sprint: #N` |
| `auto-close-sprint` | Issue closed, body contains `Parent Sprint` | Recomputes the parent sprint's burn-down/health and rewrites its status section; auto-closes the sprint at 100% |
| `notify-release-approver` | Issue opened, labeled `production` | Comments on the issue tagging the repo's `RELEASE_APPROVER` |
| `authorize-deployment` | Comment posted on a `production`-labeled issue | Checks the commenter and keyword against `RELEASE_APPROVER`/`QA_APPROVER`; once both approve, adds `ready-for-deploy` |
| `auto-assign-qa` | Issue opened/labeled `qa` or `qa-request` | Assigns the repo's configured `QA_ASSIGNEES` |
| `telegram-issues` | Issue/comment/PR events | Sends a Telegram alert if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are configured |
| `setup-labels` | Manual (`workflow_dispatch`) | One-time run that creates all labels Delivery OS needs |

Workflows and templates are **copied directly** into your repo. No `workflow_call` or external references.

Installing via `npx github-delivery-os` (not the `scripts/install.sh` clone path) also writes `.github/delivery-os.json`, a small manifest recording the installed version — this is what powers the update check in `status`. It's only written when the files it describes are actually current (a fresh install, or `--overwrite`); a skip-mode install over existing files leaves it untouched rather than claiming a version that isn't really on disk. `uninstall` removes it.

With `--with-skill`, a `.claude/skills/delivery-ops/SKILL.md` file is also written — a Claude Code skill scoped to this repo, so anyone working here with Claude Code can create issues that correctly trigger the workflows above, comment as an approver, and check status without knowing the underlying `gh` commands or issue-body formats by heart. It's opt-in and retroactive: `--with-skill` on any later `install` call adds it if it isn't there yet.

---

## Quick Start (After Install)

1. **Create labels:** Actions → Setup Labels → Run workflow
2. **Configure variables:** Settings → Secrets and variables → Actions → Variables
   - `RELEASE_APPROVER` — GitHub username
   - `QA_APPROVER` — GitHub username
   - `QA_ASSIGNEES` — Comma-separated usernames (e.g. `user1,user2`)
3. **Optional:** Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for alerts

---

## Sprint Child Creation

When you open an issue using the **Sprint Planning** template with a title like `SPRINT - Sprint 12`:

1. Each line under "Sprint Features (One Per Line)" becomes a child issue
2. Child issues link back with `Parent Sprint: #N`
3. Closing child issues updates burn-down; sprint auto-closes at 100%

**Required:** Install with `--with-templates` so the sprint form is available.

---

## Operating From Claude Code (`--with-skill`)

Installing with `--with-skill` drops a `.claude/skills/delivery-ops/SKILL.md` skill into the repo, scoped to *this* repo's Delivery OS install. It lets anyone using [Claude Code](https://claude.com/claude-code) drive the workflows above by asking in plain language — e.g. "create a sprint for the checkout redesign" — instead of hand-building `gh issue create` calls and remembering each template's exact field names.

Before doing anything, it checks the target repo: confirms Delivery OS is actually installed, that `Setup Labels` has been run, and that `RELEASE_APPROVER` / `QA_APPROVER` / `QA_ASSIGNEES` are configured — flagging (or offering to fix) gaps instead of silently creating an issue that does nothing. It also always shows the constructed title/body/labels or comment text for confirmation before creating or posting for real, since these are visible actions in the repo's activity, not a local preview.

### Create a sprint
1. Ask: *"Create a sprint called Sprint 14 for \<goal>, running \<start> to \<end>, with features: \<one per line>"*
2. It opens an issue titled `SPRINT - Sprint 14`, labeled `sprint` + `planning`, with `### Sprint Name` / `Start` / `End` / `Goal` / `Features (One Per Line)` / `Approved` fields filled in.
3. On open, `sprint-child-creator` splits each feature line into its own child issue, labeled `sprint-active` and linked back with `Parent Sprint: #N`.
4. Close each child issue as work finishes — that's what advances the burn-down; `auto-close-sprint` recomputes it and rewrites the parent's `## 🚦 Sprint Status` section, auto-closing the sprint at 100%.

### Request a production release
1. Ask: *"Open a production release for \<project> v1.2.0, sprint #N, summary: \<summary>"*
2. It opens an issue titled `PRODUCTION RELEASE - <project> - v1.2.0`, labeled `release` + `production` + `approval`, with the sprint reference, version, release summary, QA summary/links, and `Deployment Authorized: No`.
3. On open, `notify-release-approver` comments tagging the repo's configured `RELEASE_APPROVER`.

### Approve or decline a release
1. Ask: *"Approve release #N"* or *"Decline release #N — \<reason>"*.
2. It checks that the currently authenticated `gh` login matches the repo's `RELEASE_APPROVER` — if not, it stops and says so instead of posting a comment that would silently do nothing.
3. It posts a comment starting with a recognized keyword (`approved`, `ok`, `go ahead` to approve; `declined`, `rejected`, `not approved` to decline) — `authorize-deployment` only reacts to that leading keyword from the exact configured approver. A later comment from the same approver overrides an earlier one.

### Request QA
1. Ask: *"Open a QA request for \<feature>, related to issue #N, testing \<what/where>"*
2. It opens an issue titled `QA REQUEST - <feature>`, labeled `qa-request`, with the related task, what to test, environment/build link, and acceptance criteria.
3. On open, `auto-assign-qa` assigns the repo's configured `QA_ASSIGNEES`.

### Approve QA
1. Ask: *"Mark QA #N as approved"* (or *"looks good"*).
2. Same login check as release approval, but against `QA_APPROVER`.
3. Posts a comment starting with `qa approved`, `approved`, `qa ok`, or `looks good`.

### Report a bug
1. Ask: *"File a bug: \<one-line summary>, severity \<level>, steps: \<...>"*
2. It opens an issue titled `[BUG] <summary>`, labeled `bug` + `qa`, with platform, severity, build/version, steps to reproduce, expected vs. actual result, and test environment.

### Track a task
1. Ask: *"Create a task to \<summary>, owner \<name>, priority P1"*
2. It opens an issue titled `TASK - <summary>`, labeled `task`, with owner, priority, status, acceptance criteria, and links. (No workflow trigger — this is plain tracking.)

### Check status
- *"What's the status of issue #N?"* → current labels and latest comments.
- *"How's Sprint 14 doing?"* → reads the parent issue's `## 🚦 Sprint Status` section (progress %, time elapsed, health, burn-down bar).
- *"What releases are waiting on approval?"* / *"What sprints are active?"* / *"What QA requests are open?"* → lists issues by label (`production`, `sprint`, `qa-request`) so you don't need an issue number in hand.

See [How To](docs/how-to.md) for the underlying workflows this drives, field by field.

### Example: filing a bug and a task, step by step

Worked against `jkaweesi22/klero`, a repo with Delivery OS installed. The bug part of this was actually run — that issue really exists at [jkaweesi22/klero#1](https://github.com/jkaweesi22/klero/issues/1); the task part follows the identical steps but wasn't actually created, shown for the field shape only.

**Filing the bug:**

1. In Claude Code, inside (or pointed at, via `--repo`) the target repo, describe the bug in plain language:
   > *File a bug on jkaweesi22/klero — the order request form submits with an empty phone number, severity high. Steps: fill in the form, leave phone blank, submit. Expected: should block submission. Actual: submits anyway, so there's no way to contact the customer. Tested on Chrome, desktop, production.*
2. Claude pre-flights the repo — confirms Delivery OS is installed and the `bug`/`qa` labels exist.
3. Claude shows the exact issue it's about to create before doing anything:
   - Title: `[BUG] Order request form submits with empty phone number`
   - Labels: `bug`, `qa`
   - Body, field by field: `Platform(s) Affected` → Web, `Severity` → High, `Build / Version` → main (as deployed), `Bug Summary`, `Steps to Reproduce` (numbered), `Expected Result`, `Actual Result`, `Test Environment` → Chrome, desktop, production.
4. Confirm ("yes") when asked to create it.
5. Claude runs `gh issue create` and reports back the issue — [jkaweesi22/klero#1](https://github.com/jkaweesi22/klero/issues/1). Nothing else happens automatically; bug reports don't trigger a workflow, they're just labeled and tracked.

**Filing the follow-up task:**

1. Ask Claude to turn the bug into tracked work, referencing the bug's issue number:
   > *Create a task to add phone number validation to the order form, owner @jkaweesi22, priority P1, status Backlog, acceptance: form blocks submission until a valid phone number is entered. Link it to #1.*
2. Claude shows the constructed issue:
   - Title: `TASK - Add phone number validation to order form`
   - Labels: `task`
   - Body: `Task Summary`, `Description` (references #1), `Owner` → @jkaweesi22, `Priority` → P1 - High, `Status` → Backlog, `Acceptance Criteria`, `Artifacts / Links` → Related bug: #1.
3. Confirm ("yes") to create it.
4. Claude runs `gh issue create`. Same as the bug — no workflow trigger, just labeled and tracked, now linked back to the bug it addresses.

### Full example: shipping a feature end-to-end

A realistic Claude Code session, run from inside the consumer repo (the skill defaults to it since it was installed with `--with-skill` there). `RELEASE_APPROVER`, `QA_APPROVER`, and `QA_ASSIGNEES` are already configured.

```
You: Create a sprint called "Sprint 14 - Checkout Revamp", running 2026-09-16 to
     2026-09-30, goal is shipping the new checkout flow, features:
     - Redesign cart summary
     - Add saved payment methods
     - Fix tax rounding bug

Claude: This will create an issue in acme/storefront:

          Title:  SPRINT - Sprint 14 - Checkout Revamp
          Labels: sprint, planning
          Body:
            ### Sprint Name
            Sprint 14 - Checkout Revamp
            ### Sprint Start
            2026-09-16
            ### Sprint End
            2026-09-30
            ### Sprint Goal
            Ship the new checkout flow
            ### Sprint Features (One Per Line)
            Redesign cart summary
            Add saved payment methods
            Fix tax rounding bug
            ### Sprint Approved
            Pending

        Create this issue?

You: yes

Claude: Created #52. sprint-child-creator will fire on open and create one child
        issue per feature — #53 "Redesign cart summary", #54 "Add saved payment
        methods", #55 "Fix tax rounding bug" — each labeled sprint-active and
        linked back with "Parent Sprint: #52".

  [ ... engineers do the work, close #53 and #54 as they land ... ]

You: How's Sprint 14 doing?

Claude: Reading #52... ## 🚦 Sprint Status: 67% complete (2/3 closed), 20% of
        sprint time elapsed, 🟢 on track.

You: QA found a rounding issue in the tax calc — file a bug. Severity high,
     repros on checkout with 3+ items, expected total matches line items,
     actual is off by $0.01.

Claude: This will create an issue in acme/storefront:

          Title:  [BUG] Tax rounding off by $0.01 with 3+ items
          Labels: bug, qa
          Body: (Platform, Severity: High, Steps to Reproduce, Expected vs.
                 Actual Result, Test Environment filled in from what you said)

        Create this issue?

You: yes

Claude: Created #56.

  [ ... #55 fixed, referencing #56 ... ]

You: Open a QA request for the tax rounding fix, related to #55, test on
     staging, acceptance: totals match to the cent for carts of 1-10 items.

Claude: This will create an issue in acme/storefront:

          Title:  QA REQUEST - Tax rounding fix
          Labels: qa-request
          Body: (Related Sprint Task Issue #55, What to Test, Environment +
                 Build Link: staging, Acceptance Criteria filled in)

        Create this issue?

You: yes

Claude: Created #57. auto-assign-qa will assign it to the configured
        QA_ASSIGNEES.

  [ ... QA tests it, comes back clean ... ]

You: Mark QA #57 as approved, looks good.

Claude: Checking gh auth status... authenticated as jane-qa, which matches this
        repo's QA_APPROVER. Posting:

          "looks good — verified on staging, totals match to the cent"

        on #57.

You: yes, post it

Claude: Posted. Now close #55 to update the sprint burn-down?

You: yes

Claude: Closed #55. Sprint 14 is now 100% complete — auto-close-sprint closed
        #52 and posted a completion comment.

You: Open a production release for storefront v2.4.1, sprint #52, summary
     "checkout revamp: new cart summary, saved payment methods, tax rounding
     fix", QA evidence: #57.

Claude: This will create an issue in acme/storefront:

          Title:  PRODUCTION RELEASE - storefront - v2.4.1
          Labels: release, production, approval
          Body:
            ### Sprint Reference (Sprint Planning Issue #)
            #52
            ### Version / Build Number
            v2.4.1
            ### Release Summary
            Checkout revamp: new cart summary, saved payment methods, tax
            rounding fix
            ### QA Summary + Evidence Links
            #57
            ### Overall QA Recommendation
            Approve for Production
            ### Deployment Authorized
            No

        Create this issue?

You: yes

Claude: Created #58. notify-release-approver posted a comment tagging this
        repo's RELEASE_APPROVER (john-lead).

  [ ... some time later, as john-lead ... ]

You: Approve release #58.

Claude: Checking gh auth status... authenticated as john-lead, which matches
        RELEASE_APPROVER. Posting "approved" on #58.

You: yes

Claude: Posted. authorize-deployment will add ready-for-deploy once both
        approvers (release + QA) have a qualifying comment on record.
```

Each `yes` above is a real confirmation gate — Claude shows the exact issue/comment content before it creates or posts anything, since it's a visible action in the repo.

---

## Documentation

| Document | Description |
|----------|-------------|
| **[Landing page & quick start](https://phaneroo.github.io/github-delivery-operating-system/)** | Overview, one-command install, features |
| [PRFAQ](docs/PRFAQ.md) | Product overview and FAQs for all audiences (npm launch, install, governance) |
| [Press release (npm)](docs/press-release.md) | Formal announcement: Delivery OS on npm |
| [Consumer Setup](docs/consumer-setup.md) | Installation, configuration, variables, labels, Telegram, uninstall |
| [How To](docs/how-to.md) | Create sprints, request releases, approve, report bugs, QA requests |
| [Architecture](docs/architecture.md) | Workflows, templates, data flow |
| [Governance](docs/governance.md) | Lifecycle, approval gates, automation rules |

---

## License

MIT License. See [LICENSE](LICENSE) for details.
