# GitHub Delivery Operating System

> A GitHub-native Delivery Governance Framework for structured sprint execution, QA review, and collaborative production release control.

[![Socket Badge](https://badge.socket.dev/npm/package/github-delivery-os)](https://socket.dev/npm/package/github-delivery-os)

Delivery OS embeds structured intake, sprint orchestration, QA governance, and collaborative release gates directly into your GitHub repos — replacing informal coordination (manual approvals, inconsistent sprint tracking, socially enforced releases) without replacing your CI/CD or disrupting how you already work.

## Install

```bash
npx github-delivery-os install --with-templates .
```

From your repo root. Add `--with-labels` to create labels via `gh` CLI, `--with-skill` for the [Claude Code](https://claude.com/claude-code) skill, `--dry-run` to preview first. See the [landing page](https://phaneroo.github.io/github-delivery-operating-system/#install) for every flag combination and when to use it, or [Consumer Setup](docs/consumer-setup.md) for the clone-and-run alternative, configuration, and troubleshooting.

## What you get

| | |
|---|---|
| **Sprint child creation** | One issue per feature line, automatic burn-down, auto-close at 100% |
| **Dual approval gates** | Release approver + QA sign-off required before deploy |
| **Rolling QA reminder** | Every change that reaches `main` is added to one open *"QA REQUEST - Changes awaiting QA"* issue; the QA approver approves or declines it with a comment or a checkbox |
| **Auto-assign QA & Telegram alerts** | QA-labeled issues get assigned automatically; optional alerts for bugs, QA, sprints, releases |
| **Claude Code skill** (`--with-skill`) | Operate it all in plain language — see below |

The Claude Code skill (`.claude/skills/delivery-ops/SKILL.md`) can:
- **Create issues that trigger real automation** — sprint planning, production release, QA request, and bug issues shaped exactly as the installed workflows expect, not just plain issues
- **Comment as an approver** — release/QA sign-off in the phrasing `authorize-deployment` actually recognizes
- **Check status** — labels, latest comments, sprint burn-down
- **Run autonomous task tracking** — notice tasks/bugs while working in a session, file them, group them into phases via sprints, maintain a roadmap issue, and update/close them as work progresses
- **Turn a spec into a full breakdown** — an SRS/PRD or a plain-language feature description becomes real phase (sprint) and task issues, not just a document
- **Run a cleanup sweep** — finds stale/orphaned/inconsistent issues and roadmap drift, always confirmed before anything is touched

Full workflow table, quick start, and Claude Code walkthroughs are on the [landing page](https://phaneroo.github.io/github-delivery-operating-system/).

### Rolling QA issue

Each direct push to `main` and each PR merged into `main` adds a checklist line to a single open issue, *QA REQUEST - Changes awaiting QA*. Docs-only changes and `[skip qa-request]` commits are left off. A repo never has more than one of these open.

Only the QA approver (`QA_APPROVER`) can decide:
- **Approve:** comment starting with `qa approved`, `approved`, `qa ok`, `looks good`, `lgtm`, `all good`, `good to go`, `ship it` (anything may follow), or just `ok`, `approve`, `tested` or `passed` as the whole comment ("Tested!" counts; "Ok, I'll test tomorrow" doesn't), or with ✅ 👍 ✔️. Or tick the issue's **Approved** box. This closes the issue, and the next change opens a fresh one.
- **Decline:** comment starting with `not approved`, `declined`, `decline`, `rejected`, `reject`, `failed`, `changes needed`, `needs work`, `not ok`, `blocked`, or with ❌ 👎 🚫. The issue stays open, and fixes are added to it.

Emoji *reactions* don't count, because GitHub Actions can't see them; put the emoji in a comment. To go back to one QA Request per change, set the repo variable `DELIVERY_OS_AUTO_QA_MODE=per-change`. Details are in [Consumer Setup](docs/consumer-setup.md#rolling-qa-issue-default).

## Documentation

| Document | Description |
|----------|-------------|
| **[Landing page & quick start](https://phaneroo.github.io/github-delivery-operating-system/)** | Overview, full command reference, workflows, Claude Code walkthroughs |
| [PRFAQ](docs/PRFAQ.md) | Product overview and FAQs for all audiences (npm launch, install, governance) |
| [Press release (npm)](docs/press-release.md) | Formal announcement: Delivery OS on npm |
| [Consumer Setup](docs/consumer-setup.md) | Installation, configuration, variables, labels, Telegram, uninstall |
| [How To](docs/how-to.md) | Create sprints, request releases, approve, report bugs, QA requests |
| [Architecture](docs/architecture.md) | Workflows, templates, data flow |
| [Governance](docs/governance.md) | Lifecycle, approval gates, automation rules |

## License

MIT License. See [LICENSE](LICENSE) for details.
