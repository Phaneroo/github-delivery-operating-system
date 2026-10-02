---
name: delivery-os-setup
description: First-time setup of GitHub Delivery OS in a repo: help someone choose what to install (the lite bundle for one person or a small project, the full system for a team with QA, or a hand-picked set), preview with a dry run, and install after a yes. Use when asked to set up, install, add or adopt Delivery OS, for a "lite" or minimal install, or "which workflows do I need" in a repo that does not have it yet. Once Delivery OS is installed and the delivery-ops skill is in the repo, use delivery-ops instead, for everything after: sprints, releases, approvals, status, and turning pieces on or off.
---

# Set up Delivery OS

You help someone decide what to install and then install it, using the `github-delivery-os` CLI. You do not copy files or edit workflows yourself: the CLI does the installing, and you choose its flags.

This skill is the front door, used once. Everything after the install (sprints, releases, approvals, status, and turning pieces on or off later) is the `delivery-ops` skill, which the install puts in the repo. The person should feel it is one assistant: finish by handing over (section 5), and never make them choose between skills.

## 1. Look before asking

- Which repo? The current directory unless they name another. Confirm it is a git repo with a GitHub remote (`git remote -v`); labels and the approver setup need that, and `gh auth status` to be signed in. If either is missing, say what it limits, and carry on.
- Is Delivery OS already there? Run `npx github-delivery-os@latest status --offline .`.
  - **Not installed:** this is first-time setup. Carry on below.
  - **Installed, and `.claude/skills/delivery-ops` is in the repo:** this is not setup any more. Say so in one line ("Delivery OS is already here, so I'll use the repo's delivery-ops skill for that") and hand over: whatever they asked (add Telegram, add or remove QA, see what's installed, a sprint, a release) is `delivery-ops`'s job. Don't redo the interview.
  - **Installed, but without the `delivery-ops` skill:** offer to add it (`npx github-delivery-os@latest install --with-skill .` leaves existing files alone), and meanwhile make the change they asked for with the CLI exactly as `delivery-ops` would (`list .`, then `add` / `remove` with `--dry-run` first, confirm, run). Say which bundle they are on (`Bundle:` in the status output; none means full). Installing never removes files already there; going smaller is `remove`, or `uninstall` for everything, which you only run if they ask.
- What can be installed? Run `npx github-delivery-os@latest list --json` and use its bundles, workflows, descriptions and `needs`. Don't rely on a remembered list, because it changes between releases.

## 2. Ask, in plain words

Keep it to what changes the answer, one short question at a time, and skip any whose answer you can already see:

1. **Who works on this?** Just them, or a team?
2. **Does anyone separate from the author test changes before release** (a QA person, or a sign-off step they want)?
3. **Do they use Claude Code in this repo?** If yes, include `--with-skill` (recommended): it puts the `delivery-ops` skill in the repo, so everything after the install, including changing what's installed, is just asking Claude. If they say no, leave it out.
4. **Telegram alerts?** Only if they ask about notifications or alerts.

Then recommend, with a reason, and let them overrule it:

| Their situation | Recommend | Command pieces |
|---|---|---|
| One person, or a very small team that doesn't want a QA step | **lite** | `--bundle lite` |
| A team with a QA step, or they want the rolling QA checklist | **full** | (default) |
| They want specific parts only | **hand-picked** | `--only a,b` or `--skip a,b` (optionally with `--bundle lite`) |
| Starting small but may want QA sign-off or Telegram later | **lite now, packs later** | `--bundle lite`, then `add qa` / `add telegram` when needed |

Starting small is safe because nothing is locked in: packs and single workflows can be added or removed later without reinstalling (`list --json` shows both, and what is installed in the repo).

What lite is, in one breath: sprints with child tasks and burn-down, task and bug forms, and a Production Release where **one approval from them** ships it. No QA Requests, no rolling QA issue, no QA assignment, no Telegram. Say it before they choose. For a hand-picked set, name each workflow in plain words from `list`, and mention any `needs` (for example the rolling-QA approval does little without the workflow that creates the rolling QA issue).

## 3. Build the command, preview, then install

Always include `--with-templates` (the issue forms; sprint child creation needs them) and `--with-labels` (needs `gh`; skip it and say so if `gh` isn't signed in). Add `--with-skill` if they use Claude Code. Example for a solo project:

```
npx github-delivery-os@latest install --bundle lite --with-templates --with-labels --with-skill .
```

1. Run the same command with `--dry-run` first, and show them what it would create, in a few lines, not the raw log.
2. **Ask before the real run.** Installing writes files into their repo.
3. Run it for real, then `npx github-delivery-os@latest status .` and report the result.

## 4. The approver (lite)

A lite install sets the repo variable `RELEASE_APPROVER` to the **person running the install** (their GitHub login, via `gh`) and prints that it did. It never overwrites a value that is already set. Tell them this before the real run, because it names a person with authority over releases; `--no-set-approvers` skips it, and then they set the variable themselves (Settings → Secrets and variables → Actions → Variables). Do not set any repo variable yourself with `gh variable set`; the install does it when appropriate, and anything else is for them to decide.

## 5. After installing

Tell them, briefly:

- If labels weren't created: Actions → **Setup Labels** → Run workflow.
- Lite: to ship a release, open a Production Release issue and comment `approved` as the approver. There is no QA approver to configure. Full: set `RELEASE_APPROVER`, `QA_APPROVER` and `QA_ASSIGNEES` (they can be lists).
- **Hand over.** If the `delivery-ops` skill was added, finish with something like: "From here on just ask me normally: create a sprint, file a bug, request or approve a release, or say 'add QA sign-off' / 'turn on Telegram' / 'what's installed?' whenever your needs change. Nothing is locked in." If they did not take the skill, say the same is possible with the CLI (`list`, `add`, `remove`) and that adding the skill later is one command.

## Rules

- Don't invent flags or workflow names; take them from `list --json` and `npx github-delivery-os@latest install --help`.
- Don't install, update or uninstall without a clear yes, and don't remove anything unless asked.
- If the CLI prints an error or a note (unknown workflow, a workflow that has little to do alone), relay it plainly and fix the command, rather than working around it.
