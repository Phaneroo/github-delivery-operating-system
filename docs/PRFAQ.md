# Product and frequently asked questions (PRFAQ)

**GitHub Delivery Operating System (`github-delivery-os`)**

This document answers common questions for **engineering leaders**, **DevOps and platform teams**, **release managers**, and **individual contributors** evaluating or adopting Delivery OS.

---

## 1. What problem does this solve?

Teams often coordinate delivery in GitHub informally: ad hoc sprints, inconsistent QA handoffs, and production approvals that are hard to audit or repeat across repositories.

Before the npm package, adopting the same workflow set usually meant **cloning**, **manually copying** files, or **rebuilding** similar automation yourself—leading to **drift** between repos and **slow** rollout.

**`github-delivery-os`** installs workflows and templates into a target repo with a **documented CLI**, so behavior stays **aligned** with the published model and **versioned** releases on npm.

---

## 2. What is `github-delivery-os`?

**`github-delivery-os`** is the npm package name for the **GitHub Delivery Operating System**.

It ships a **command-line interface** that copies **GitHub Actions** workflows and, optionally, **issue templates** into a repository you specify. After installation, all automation runs **inside that repository** on GitHub.

| Resource | Link |
|----------|------|
| npm | [github-delivery-os](https://www.npmjs.com/package/github-delivery-os) |
| Homepage | [GitHub Pages site](https://phaneroo.github.io/github-delivery-operating-system/) |
| Source | [github-delivery-operating-system](https://github.com/Phaneroo/github-delivery-operating-system) |
| License | MIT (see repository) |

---

## 3. How do I install it?

Run this from the **root** of the repository where you want the files:

```bash
npx github-delivery-os install --with-templates .
```

Common flags:

| Flag | Purpose |
|------|---------|
| `--with-templates` | Copy issue templates (recommended for sprint and release forms). |
| `--with-labels` | Create labels using the GitHub CLI (`gh`); requires authentication. |
| `--with-skill` | Add a Claude Code skill for operating this repo's Delivery OS from Claude Code. Optional. |
| `--dry-run` | Show planned changes without writing files. |
| `--overwrite` | Replace existing Delivery OS files (use when upgrading; prefer `--dry-run` first). |

Other commands include `status` and `uninstall`. By default, existing files are **not** overwritten unless you opt in.

---

## 4. What gets installed?

Typical workflows (names may vary by release):

| Area | Behavior |
|------|----------|
| Sprint | Create child issues from sprint planning issues whose title contains `SPRINT -` and whose body lists features. |
| Sprint completion | Update burn-down and optionally auto-close the sprint when work is complete. |
| Production | Notify a release approver when production-style issues are opened. |
| Approvals | Apply `ready-for-deploy` after dual approval rules in [Governance](governance.md). |
| QA | Auto-assign QA on issues labeled `qa` or `qa-request`. |
| Notifications | Optional Telegram messages for configured events. |
| Labels | A workflow to create required labels on demand. |

With `--with-templates`, you get structured forms for sprints, tasks, bugs, QA requests, production sign-off, and configuration. See [Architecture](architecture.md) for the full list and triggers.

---

## 5. How is this different from branch protection and pull requests alone?

GitHub’s built-in features focus on **code review** and **branch rules**. Delivery OS adds an **issue-centric lifecycle**: planned sprints as issues, QA requests, production release issues, **label-driven** state, and **comment-based** approval rules that your organization configures. It complements—not replaces—CI/CD pipelines.

---

## 6. What configuration is required after install?

Set **GitHub Actions variables** (Repository → Settings → Secrets and variables → Actions → Variables) as described in [Consumer Setup](consumer-setup.md), for example:

- `RELEASE_APPROVER` — GitHub username for release approval flows.
- `QA_APPROVER` — GitHub username for QA approval in dual-approval scenarios.
- `QA_ASSIGNEES` — Comma-separated handles for QA assignment.
- `PROJECT_NAME` — Optional display name in notifications.

Optional **secrets** for Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Create labels via the **Setup Labels** workflow or `install --with-labels` with `gh` authenticated.

---

## 7. How does sprint planning work?

Use the **Sprint Planning** template (requires installing with `--with-templates`). The issue title should include **`SPRINT -`**. List one feature per line in the **Sprint Features** section. The automation creates linked child issues; closing them updates progress and can auto-close the sprint when complete. Details: [How To](how-to.md).

---

## 8. What prevents unapproved production deployment?

Production flows are designed so that **`ready-for-deploy`** is applied only when **governance conditions** in the workflows and [Governance](governance.md) are met—typically including **dual approval** via comments from configured approvers. Decline keywords remove readiness as documented. Telegram, if enabled, surfaces key events for visibility.

---

## 9. Do I have to use npm?

No. You may **clone** this repository and use the shell installer scripts documented in [Consumer Setup](consumer-setup.md). npm is the **recommended** path for quick adoption and **pinned versions** (`npx github-delivery-os@x.y.z`) when you need reproducible installs.

---

## 10. What are the main benefits?

- **Repeatable** governance across many repositories.  
- **Less manual copying** of YAML and templates.  
- **Auditable** automation in your own repo.  
- **Clear documentation** for onboarding.  
- **MIT license** for broad use.

---

## 11. Is it suitable for large organizations?

The model is **per-repository** and **workflow-driven**, which scales by rolling the same install process out to each repo. Teams with stricter change control can pin npm versions, review diffs in pull requests, and align variables with internal policies.

---

## 12. Roadmap (high level)

Directions under consideration include stronger **enterprise pinning** documentation, **environment-specific** gates (for example staging versus production), **metrics** on approvals and cycle time, and continued documentation improvements. Priorities may change; watch [releases](https://github.com/Phaneroo/github-delivery-operating-system/releases) and the repository for updates.

---

## Document history

This PRFAQ describes the **GitHub Delivery Operating System** as published in the open-source repository. For the latest behavior, always refer to the version you install and the **Governance** and **Architecture** docs in the same release.
