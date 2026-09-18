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
| **Auto-assign QA & Telegram alerts** | QA-labeled issues get assigned automatically; optional alerts for bugs, QA, sprints, releases |
| **Claude Code skill** (`--with-skill`) | Operate it all in plain language — create/comment/check status, autonomous task tracking, and turning a spec into a full phase-and-task breakdown |

Full workflow table, quick start, and Claude Code walkthroughs are on the [landing page](https://phaneroo.github.io/github-delivery-operating-system/).

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
