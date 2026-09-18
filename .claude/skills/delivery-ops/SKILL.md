---
name: delivery-ops
description: Operate a repo that has GitHub Delivery OS installed — create sprint/production-release/QA-request/bug issues that actually trigger its automation, comment as an approver in phrasing its workflows recognize, check status (labels, latest comments, burn-down), and run autonomous task tracking (identify tasks/bugs, group them into phases via sprints, maintain a roadmap issue, update status, comment, and close as work progresses). Targets a specific repo via --repo; defaults to the current repo if this skill was installed into it and none is named. Use when asked to create a sprint, request a release, approve/decline a release, check release or sprint status, track/file a task or bug found during work, plan or check a roadmap/phase, or demo/test Delivery OS against a given repo.
---

# Operate Delivery OS

This drives the actual product — the workflows Delivery OS installs into a consumer repo — as a user of that repo would, not the tooling that ships the `github-delivery-os` package itself (that's the separate `release` skill). Use it to create issues that correctly trigger the installed automation, comment in a way the automation actually recognizes, and check what state something is in.

## Which repo?

Every command below takes `--repo <owner>/<name>` explicitly — never assume based on the working directory alone. Two ways this gets decided:

- **This skill was installed via `npx github-delivery-os install --with-skill`, into a specific repo's own `.claude/skills/`.** In that case the current working directory *is* the repo Delivery OS is installed in, so it's a reasonable default target if the user doesn't name a different one — just confirm that's what they mean before acting.
- **This skill is installed generically** (copied into `~/.claude/skills/`, available across every project). Here there's no natural default — the working directory could be anything. Ask which repo if it isn't named.

Creating issues and comments in a repo is a visible, outward action — other collaborators see it. Confirm the target repo and intent before creating anything real, the same as any other action that shows up in someone else's GitHub activity.

## Pre-flight check

Before creating anything that depends on configuration, check the target repo actually has Delivery OS installed and configured — a silent no-op (nothing happens because a variable is unset) is more confusing than an upfront "this won't do much yet":

- **Installed?** `gh api repos/<owner>/<repo>/contents/.github/workflows/authorize-deployment.yml --silent` (404 = not installed — suggest `npx github-delivery-os status .` or `install --with-templates` in that repo).
- **Labels set up?** `gh label list --repo <owner>/<repo>` — look for `production`, `qa`, `qa-request`, `sprint`, `sprint-active`, `planning`, `declined`, `ready-for-deploy`. Missing labels mean `Setup Labels` hasn't been run there yet — offer to fix it directly rather than just reporting the gap: `gh workflow run setup-labels.yml --repo <owner>/<repo>` (it's a `workflow_dispatch` trigger, so this actually creates them on the spot). Confirm with the user first since it's a real change to their repo.
- **Repo variables set?** `gh variable list --repo <owner>/<repo>` — look for `RELEASE_APPROVER`, `QA_APPROVER`, `QA_ASSIGNEES`. If unset, say so plainly: the issue will still get created, but `notify-release-approver` will ping the literal placeholder `release-approver`/`qa-approver`, not a real person. Setting these requires repo admin access (`gh variable set NAME --repo <owner>/<repo> --body <value>`) — don't set them without being asked to, since they name a real person as approver.

## Creating issues

`gh issue create` does not render GitHub's Issue Forms (the `.github/ISSUE_TEMPLATE/*.yml` files) — those only exist in the web UI. So the body has to be hand-built to match what a form submission would actually produce: `### <Field Label>` headings with the answer beneath each, because that heading text is exactly what the workflows regex-parse. Labels have to be passed explicitly too, since the template's auto-applied labels are also bypassed.

**Show the constructed title, body, and labels before actually creating the issue** — this is a real, visible action in someone else's repo, not a preview in this conversation. Get confirmation on the content, not just the target repo, before calling `gh issue create`.

**Sprint Planning** — triggers `sprint-child-creator` (one child issue per feature line, each labeled `sprint-active`, on open):
- Title **must contain** the literal string `SPRINT -`, e.g. `SPRINT - Sprint 14`
- Labels: `sprint`, `planning`
- Body:
  ```
  ### Sprint Name

  <name>

  ### Sprint Start

  YYYY-MM-DD

  ### Sprint End

  YYYY-MM-DD

  ### Sprint Goal

  <goal>

  ### Sprint Features (One Per Line)

  <feature one>
  <feature two>
  <feature three>

  ### Sprint Approved

  Pending
  ```
  One feature per line, no bullets/numbering (matches the template's own instruction — `sprint-child-creator`'s parser just splits on newlines).

**Production Release** — triggers `notify-release-approver` on open (posts a comment tagging `RELEASE_APPROVER`), and later `authorize-deployment` on comments:
- Title: `PRODUCTION RELEASE - <project> - vX.X.X`
- Labels: `release`, `production`, `approval`
- Body:
  ```
  ### Sprint Reference (Sprint Planning Issue #)

  #<N>

  ### Version / Build Number

  vX.X.X

  ### Release Summary

  <summary>

  ### QA Summary + Evidence Links

  <links, or "None yet">

  ### Overall QA Recommendation

  Approve for Production

  ### Deployment Authorized

  No
  ```
  (`qa_recommendation` drives the "QA Recommendation" line `notify-release-approver` puts in its comment — use `Approve for Production`, `Reject Release`, or `Conditional Approval` verbatim, those are the three strings it checks for.)

**QA Request** — triggers `auto-assign-qa` (assigns `QA_ASSIGNEES`) on open:
- Title: `QA REQUEST - <feature/issue>`
- Labels: `qa-request`
- Body:
  ```
  ### Related Sprint Task Issue (#)

  #<N>

  ### What to Test

  <what to test>

  ### Environment + Build Link

  <build link>

  ### Acceptance Criteria

  <criteria>

  ### QA Outcome

  Pending
  ```

**Bug Report**:
- Title: `[BUG] <one-line summary>`
- Labels: `bug`, `qa`
- Body: mirror `bug_report.yml`'s fields (`Platform(s) Affected`, `Severity`, `Build / Version`, `Bug Summary`, `Steps to Reproduce`, `Expected Result`, `Actual Result`, `Test Environment`) as `### <label>` / answer pairs.

**Task** — no automation trigger, just structured tracking:
- Title: `TASK - <one-line summary>`
- Labels: `task`
- Body: mirror `task.yml`'s fields (`Task Summary`, `Description`, `Owner`, `Priority` — `P0 - Critical` / `P1 - High` / `P2 - Medium` / `P3 - Low`, `Status` — `Backlog` / `In Progress` / `Blocked` / `Ready for Review` / `Done`, `Acceptance Criteria`, `Artifacts / Links`) as `### <label>` / answer pairs.

## Commenting as an approver

`authorize-deployment` only registers a comment if **both** of these hold:
- It's posted by the exact GitHub login configured in the repo's `RELEASE_APPROVER` or `QA_APPROVER` variable. `gh issue comment` posts as whichever account `gh auth status` shows — if that's not the configured approver, the comment is just a comment, nothing fires.
- The comment **leads with** one of the recognized keywords (case-insensitive; anything after the keyword is fine, but the keyword itself has to be at the start):
  - Release approve: `approved`, `approve`, `ok`, `go ahead`
  - Release decline: `declined`, `rejected`, `reject`, `not approved`
  - QA approve: `qa approved`, `approved`, `qa ok`, `looks good`

A later qualifying comment from the same approver overrides an earlier one — a decline can be superseded by a later approval once fixes land, and vice versa.

**Before posting, check that the authenticated login actually matches the approver you're commenting as** — `gh auth status` (or `gh api user --jq .login`) against the `RELEASE_APPROVER`/`QA_APPROVER` value from the pre-flight check. If they don't match, say so and stop: the comment would still post, look successful, and do nothing — a silent no-op that's easy to miss without this check, since `gh issue comment` succeeds either way.

```
gh issue comment <number> --repo <owner>/<repo> --body "Approved, ship it"
```

## Checking status

- **Latest comment(s):** `gh issue view <number> --repo <owner>/<repo> --comments`
- **Current labels:** `gh issue view <number> --repo <owner>/<repo> --json labels`
- **Sprint burn-down:** read the sprint (parent) issue's body — `gh issue view <sprint-number> --repo <owner>/<repo> --json body` — and look for the `## 🚦 Sprint Status` section `auto-close-sprint` maintains (progress %, time elapsed %, health emoji, burn-down bar). It only exists after at least one child issue has closed.

## Advancing a sprint

Closing a sprint task (child) issue is what actually moves the burn-down — creating the sprint only creates the children, nothing updates until they close:

```
gh issue close <number> --repo <owner>/<repo>
```

`auto-close-sprint` fires on close, re-reads every `sprint-active` issue whose body contains `Parent Sprint: #<N>`, recomputes progress, and rewrites the sprint issue's `## 🚦 Sprint Status` section. At 100% it also closes the sprint issue itself and posts a completion comment. Re-check the sprint issue's body afterward to see the update — it happens as a side effect of closing the child, not as a response visible on the child issue itself.

## Autonomous tracking (identify → file → update → close)

Beyond filing one issue on request, this skill can run a piece of work's whole lifecycle: notice it, classify it, file it, keep it in sync as work happens, and close it out. GitHub issues are the only source of truth — there is no local state, and nothing here persists across sessions except what's written back to the repo.

### Confirm only when unsure

Don't ask before every action — that defeats the point. Act, then say so in one line of the conversation ("Filed #23: TASK - ...", "Updated #17 to In Progress", "Closed #17 — acceptance criteria met"). Every GitHub-visible action gets that line, regardless of confidence, so nothing happens invisibly even when nothing was asked first.

Ask first only when something is genuinely ambiguous:
- Unclear whether this is actually a new item or an update to an existing open issue
- Unclear which category it is (Task vs. Bug vs. part of a Sprint)
- Unclear whether it's actually done (e.g. a PR opened but CI hasn't run, or the acceptance criteria are only partly met)

A clear-cut case — an obvious bug just reproduced, a PR that visibly closes an issue's acceptance criteria — doesn't need a question, just the confirmation line afterward.

### Classifying a candidate

- Bug reproduced or reported while working → **Bug Report**
- Scoped, actionable follow-up (including things deliberately deferred, like [Phaneroo/github-delivery-operating-system#12](https://github.com/Phaneroo/github-delivery-operating-system/issues/12)) → **Task**
- A batch of related work with a start/end date → **Sprint** (see "Phases" below)
- Something that blocks a release or needs sign-off → **Production Release** / **QA Request** (rare mid-session; only when it's actually that, not just "important")

### Phases = Sprints, roadmap = one tracking issue

No new issue type needed — reuse what's already documented above:
- **A phase is a Sprint Planning issue.** Group Task issues under it exactly the way `sprint-child-creator` does: each child's body contains `Parent Sprint: #<N>`. This keeps the existing burn-down and auto-close automation working even though Claude, not a human, opened the children.
- **A roadmap is one persistent issue** that lists phases/sprints and their state. Title it `ROADMAP - <project/area>`. No labels or automation attach to it — Claude keeps its body current with `gh issue edit --body-file`, the same rewrite pattern `auto-close-sprint` uses for a sprint's `## 🚦 Sprint Status` section, just done by Claude on request or after a phase's state changes rather than by a workflow.

### Reconcile by querying, never by remembering

Don't rely on recalling an issue number from earlier in the conversation, and never assume it's still accurate after a gap. Before updating or closing something, requery:

```
gh issue list --repo <owner>/<repo> --label task --state open --search "<keywords from the work>"
```

This is also what makes picking work back up in a *new* session possible without any local memory — the issue list itself is the state.

### Keeping a Task issue in sync

The `### Status` field in the Task template body is the thing to keep current:
- `Backlog` → `In Progress` when work actually starts on it
- → `Ready for Review` when a PR opens against it
- → `Done` right before closing

To edit just that field: `gh issue view <number> --repo <owner>/<repo> --json body -q .body`, replace the line under `### Status` with the new value, then `gh issue edit <number> --repo <owner>/<repo> --body-file <file>`. Post a comment alongside any status change that isn't self-explanatory from the status alone (blocked and why, PR link, what shipped) — `gh issue comment <number> --repo <owner>/<repo> --body "<update>"`.

Close with `gh issue close <number> --repo <owner>/<repo> --comment "<summary of what was done>"` once the acceptance criteria are actually met — quote which ones, don't just say "done."

### Known limitation

This only tracks what happens while a Claude session is actively working — nothing reconciles state that changes in the background (a human merges a PR or closes an issue manually with no session running). That gap is tracked as its own deferred item rather than solved here: [Phaneroo/github-delivery-operating-system#12](https://github.com/Phaneroo/github-delivery-operating-system/issues/12). Mitigate it by always reconciling via `gh issue list` at the start of relevant work (see above) rather than trusting anything remembered from earlier.

## Finding things

When there's no issue number in hand yet:
- **Production releases awaiting a decision:** `gh issue list --repo <owner>/<repo> --label production --state open`
- **Active sprints:** `gh issue list --repo <owner>/<repo> --label sprint --state open` (title contains `SPRINT -`)
- **Open QA requests:** `gh issue list --repo <owner>/<repo> --label qa-request --state open`
- **A sprint's own children:** `gh issue list --repo <owner>/<repo> --label sprint-active --search "\"Parent Sprint: #<N>\" in:body"` — the exact-phrase quotes matter, otherwise the search matches "Parent", "Sprint", and the number as separate free-text terms instead of the literal phrase
