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

| Workflow | Purpose |
|----------|---------|
| `sprint-child-creator` | Creates child issues when a sprint (title `SPRINT -`) is opened |
| `auto-close-sprint` | Burn-down, sprint health, auto-close at 100% |
| `notify-release-approver` | Pings approver when production release issue opens |
| `authorize-deployment` | Dual approval (release approver + QA) |
| `auto-assign-qa` | Assigns QA team to `qa` / `qa-request` issues |
| `telegram-issues` | Telegram alerts for bugs, QA, sprints, releases |
| `setup-labels` | One-time workflow to create required labels |

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
