---
name: delivery-os-setup
description: Help someone choose what to install from GitHub Delivery OS and install it into their repo - the lite bundle for one person or a small project, the full system for a team with QA, or a hand-picked set of workflows. Asks a few plain questions, previews with a dry run, then installs after a yes. Use when asked to set up, install, add or adopt Delivery OS, to pick or customise what it installs, for a "lite" or minimal install, or "which workflows do I need". For operating a repo that already has it (issues, approvals, status), use the delivery-ops skill instead.
---

# Set up Delivery OS

You help someone decide what to install and then install it, using the `github-delivery-os` CLI. You do not copy files or edit workflows yourself: the CLI does the installing, and you choose its flags. Operating a repo that already has Delivery OS (sprints, releases, approvals, status) is the separate `delivery-ops` skill.

## 1. Look before asking

- Which repo? The current directory unless they name another. Confirm it is a git repo with a GitHub remote (`git remote -v`); labels and the approver setup need that, and `gh auth status` to be signed in. If either is missing, say what it limits, and carry on.
- Is Delivery OS already there? Run `npx github-delivery-os@latest status --offline .`. If it is, this is a change to an existing install: say which bundle it is on (`Bundle:` in the output; none means full) and what they have, and treat the rest as adding to it. Installing never removes files already there; going smaller means `uninstall` first, which you only run if they ask.
- What can be installed? Run `npx github-delivery-os@latest list --json` and use its bundles, workflows, descriptions and `needs`. Don't rely on a remembered list, because it changes between releases.

## 2. Ask, in plain words

Keep it to what changes the answer, one short question at a time, and skip any whose answer you can already see:

1. **Who works on this?** Just them, or a team?
2. **Does anyone separate from the author test changes before release** (a QA person, or a sign-off step they want)?
3. **Do they use Claude Code in this repo?** That decides the `delivery-ops` skill (`--with-skill`).
4. **Telegram alerts?** Only if they ask about notifications or alerts.

Then recommend, with a reason, and let them overrule it:

| Their situation | Recommend | Command pieces |
|---|---|---|
| One person, or a very small team that doesn't want a QA step | **lite** | `--bundle lite` |
| A team with a QA step, or they want the rolling QA checklist | **full** | (default) |
| They want specific parts only | **hand-picked** | `--only a,b` or `--skip a,b` (optionally with `--bundle lite`) |

What lite is, in one breath: sprints with child tasks and burn-down, task and bug forms, and a Production Release where **one approval from them** ships it. No QA Requests, no rolling QA issue, no QA assignment, no Telegram. Say it before they choose. For a hand-picked set, name each workflow in plain words from `list`, and mention any `needs` (for example the rolling-QA approval does little without the workflow that creates the rolling QA issue).

## 3. Build the command, preview, then install

Always include `--with-templates` (the issue forms; sprint child creation needs them) and `--with-labels` (needs `gh`; skip it and say so if `gh` isn't signed in). Add `--with-skill` if they use Claude Code. Example for a solo project:

```
npx github-delivery-os@latest install --bundle lite --with-templates --with-labels --with-skill .
```

1. Run the same command with `--dry-run` first, and show them what it would create, in a few lines, not the raw log.
2. **Ask before the real run.** Installing writes files into their repo.
3. Run it for real, then `npx github-delivery-os@latest status .` and report the result.

If they want an existing install changed, add `--update` only when they want existing Delivery OS files replaced with the latest versions; without it existing files are left as they are.

## 4. The approver (lite)

A lite install sets the repo variable `RELEASE_APPROVER` to the **person running the install** (their GitHub login, via `gh`) and prints that it did. It never overwrites a value that is already set. Tell them this before the real run, because it names a person with authority over releases; `--no-set-approvers` skips it, and then they set the variable themselves (Settings → Secrets and variables → Actions → Variables). Do not set any repo variable yourself with `gh variable set`; the install does it when appropriate, and anything else is for them to decide.

## 5. After installing

Tell them, briefly:

- If labels weren't created: Actions → **Setup Labels** → Run workflow.
- Lite: to ship a release, open a Production Release issue and comment `approved` as the approver. There is no QA approver to configure. Full: set `RELEASE_APPROVER`, `QA_APPROVER` and `QA_ASSIGNEES` (they can be lists).
- If the `delivery-ops` skill was added, they can now just ask Claude to create a sprint, file a bug, or request a release.
- Changing their mind later is cheap: `install --bundle full` fills a lite repo out; `--only`/`--skip` again replaces a hand-picked set.

## Rules

- Don't invent flags or workflow names; take them from `list --json` and `npx github-delivery-os@latest install --help`.
- Don't install, update or uninstall without a clear yes, and don't remove anything unless asked.
- If the CLI prints an error or a note (unknown workflow, a workflow that has little to do alone), relay it plainly and fix the command, rather than working around it.
