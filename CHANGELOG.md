# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-09-24

### Changed

- **New default: one rolling QA issue instead of a QA Request (+ Task) per change** (#88). Busy repos were getting two issues per push, and nothing closed them unless the repo cut Production Releases. Turning auto-filing off lost the "please test this" reminder. Now `auto-qa-request` keeps a single open issue, **QA REQUEST - Changes awaiting QA** (labels `qa-request`, `delivery-ops-filed`, `qa-rollup`):
  - Each direct push to `main` and each **merged** PR adds a checklist line, `- [ ] <title> (<short sha or #PR>) by @author — for #N`, with plain-English draft bullets under it for devs to edit.
  - If none is open, the first change opens one. The same commit or PR is never added twice. Docs-only changes and `[skip qa-request]` pushes add nothing. Rebase-merged PRs aren't counted twice.
  - Direct pushes no longer create a synthetic Task; the rolling issue is the paper trail.
  - Two runs racing to open the issue are folded into one, and concurrent appends re-check and retry.
- **Settings.** New repo variable `DELIVERY_OS_AUTO_QA_MODE`: `rolling` (default) | `per-change` (the previous behavior, unchanged) | `off`. The 1.8.0 `DELIVERY_OS_AUTO_QA` still works when the new variable is unset: `all` → per-change (so repos that chose it explicitly keep it), `pr-only` → rolling with direct pushes adding nothing, `off` → off. An unrecognized value falls back to rolling, so a typo never turns the reminder off.
- **Release roll-up** now lists every rolling-issue line (the open issue, plus ones approved since the last release) with its QA status, alongside any per-change QA Requests.

### Added

- **Approving or declining the rolling issue** (new `qa-rollup-approval.yml`). Only `QA_APPROVER` counts:
  - **Approve:** a comment starting with `qa approved`, `approved`, `approve`, `qa ok`, `ok`, `looks good`, `lgtm`, `all good`, `tested`, `passed`, `good to go` or `ship it` (case-insensitive; anything may follow), or with ✅ 👍 ✔️; or ticking the issue's **Approved: all changes above have been tested** box. This ticks every line, sets QA Outcome to *Pass*, closes the issue as completed and posts a summary. The next change opens a fresh one.
  - **Decline:** a comment starting with `not approved`, `declined`, `decline`, `rejected`, `reject`, `failed`, `changes needed`, `needs work`, `not ok` or `blocked`, or with ❌ 👎 🚫. The issue stays open with QA Outcome *Fail* and an acknowledgement, fixes append to it, and a later approval closes it.
  - Decline phrases are checked first, so `not approved` is never read as `approved`. The latest verdict wins: a decline after approval reopens the issue, or points to the newer rolling issue. Anyone else's verdict is ignored with a short reply, and a non-approver's box tick is reverted. Emoji *reactions* can't trigger Actions, so the emoji must be in a comment.
- **One shared, unit-tested verdict matcher** (`phraseRegex` / `matchVerdict` in `authorize-deployment-verdict.js`), used by both the rolling issue and `authorize-deployment`: comment-leading phrases, whole words, flexible spacing, decline before approve. The release gate keeps its original, stricter vocabulary; `lgtm` approves a rolling QA issue but not a release.
- **`qa-rollup` label** (run *Setup Labels* or `--with-labels` after updating).
- **Tests that run the real workflow scripts:** `test/fake-github.js` extracts a workflow's inline `github-script` and runs it against an in-memory GitHub. The rolling-mode filing, the approval workflow and per-change mode are all covered this way, and mutation-checked.

### Migration

- `install --update` leaves existing open auto-filed QA Requests as they are; nothing is mass-closed. When a pre-1.9.0 install that had `auto-qa-request` is updated, the output explains the new default and how to keep the old one (`DELIVERY_OS_AUTO_QA_MODE=per-change`). The `delivery-ops` skill's cleanup sweep proposes closing old per-change leftovers, and it never proposes closing the rolling issue itself.
- `status` now checks that `qa-rollup-approval.yml` has both scripts it loads, and that a roll-up-era `notify-release-approver.yml` also has `auto-qa-request.js` (the rolling checklist parser).

## [1.8.0] - 2026-09-23

### Fixed

- **`auto-qa-request` never read issue links on direct pushes** (#76): the push branch hard-coded the "PR body" to `''`, so a commit saying `Closes #27` still got a brand-new auto-filed Task. It now parses every commit message in the push (head commit first), accepting closing keywords, `Refs #N` and bare `#N` (closing keywords first). Cross-repo refs, URL fragments, pull requests and missing issues are skipped, and the first real issue wins.
- **`qaRequestAlreadyExists` substring match**: `PR #2` matched a QA Request filed for `PR #21`, so re-marking PR #2 ready for review could skip filing. The marker is now matched on the footer with a boundary.

### Added

- **Quieter by default: docs/settings-only changes file nothing.** A push or PR touching only `DELIVERY_OS_AUTO_QA_QUIET_PATHS` globs (default: `**/*.md`, `docs/**`, `LICENSE*`, editor/git config, issue templates, `CODEOWNERS`, `dependabot.yml`) no longer files a Task + QA Request. Code, workflows and `package.json` still file. `none` restores the old behavior. PRs are re-checked on every push (`synchronize`), so a PR that starts docs-only and later gains code still gets filed.
- **`DELIVERY_OS_AUTO_QA`** repo variable: `all` (default), `pr-only` (direct pushes file nothing), or `off`. **`DELIVERY_OS_AUTO_TASK=false`**: direct pushes with no linked issue file only the QA Request, with no synthetic Task. **`[skip qa-request]`** in a commit message opts out that commit; a push is skipped only when every commit in it is marked. These are repo variables, not workflow edits, so they survive `install --update`.
- **Auto-filed issues now get closed.** When a PR is closed without merging, `auto-qa-request` closes the Task/QA Request it filed for it (*not planned*). When a release is authorized, `authorize-deployment` closes every open auto-filed Task/QA Request created before the release issue (*completed*) and comments on each one. It identifies them by the auto-qa-request footer and never touches human- or skill-filed issues. Filings for a PR that hasn't merged yet are left open for the release that ships it. Reopening a PR reopens the filings closed when it was closed. Opt out with `DELIVERY_OS_AUTO_CLOSE=false`.
- **Cleanup sweep: "Auto-filed leftovers" check** in the `delivery-ops` skill. It proposes closing auto-filed issues whose work already landed. This covers repos that never cut a Production Release, and filings from before auto-close existed.
- Direct-push QA Requests now list the pushed files, and their changelog draft covers every commit in the push, not just the first 20 in the event payload. Push file and commit lists come from the compare API, because the push payload GitHub Actions delivers carries no `added`/`modified`/`removed` lists. This was found in an end-to-end run on a real repo; without it, the docs-only skip never fired for direct pushes.
- **Plain-English, dev-reviewed changelog on every QA Request** (#79): QA needs to know what changed in order to know what to test. `qa_request.yml` gains a required **What Changed (plain English)** field and a **Changelog Review** checkbox, ticked by the developer once the description is accurate. `auto-qa-request` seeds a draft from the PR's or push's commit subjects, with merge/fixup commits, `(#N)` and `Closes #N` clutter stripped. The `delivery-ops` skill writes the plain-English version from the actual diff (user-visible behavior, no code jargon, plus a `Could affect:` line). Its status check and cleanup sweep flag unreviewed changelogs. It never ticks the review box itself.
- **Release roll-up** (#82): opening a Production Release issue now also posts a *What's in this release* comment. It collects the plain-English What Changed notes from every QA Request filed since the last authorized release, plus older ones still open (e.g. a PR that merged after the previous release), marks each ✅ dev-reviewed or ⚠️ not, shows its QA outcome, and merges the **Could affect** areas into one list. Requests closed as not planned, and ones whose PR hasn't merged, are left out. It's informational only and never blocks authorization. Refresh it with `gh workflow run notify-release-approver.yml -f release_issue=<N>`, which updates the comment in place without re-pinging the approver. It runs as a separate job, so a roll-up failure can't affect the approver notification. The logic lives in the new, unit-tested `.github/scripts/release-rollup.js`. `status` checks that script is present only when the installed `notify-release-approver.yml` actually uses it, so older installs aren't flagged as broken.

### Changed

- **`actions/github-script` v7 → v9** in every workflow, which clears GitHub's outdated-action (Node runtime) warning. None of the scripts use `require('@actions/github')` or redeclare `getOctokit`, which are v9's only breaking changes.
- **Landing page** (`docs/index.html`): the install command now matches the current recommended one (`install --with-templates --with-labels --with-skill .`). A new **Updating an existing install** section shows how to check with `status` and then run `install --update`, and it's linked from the sidebar and table of contents. The workflow table now lists `auto-qa-request` (previously missing) and describes the release roll-up and release-time auto-close. The quick start mentions the new optional tuning variables.

## [1.7.2] - 2026-09-22

### Fixed

- **`status`'s not-installed hint was missing `--with-labels`/`--with-skill`**: when a repo had no Delivery OS install at all, the suggested command was `install --with-templates .`, which — unlike the already-fixed `buildUpdateCommand()` hint for partial installs (1.7.1) — completed without error but left labels and the `delivery-ops` skill uninstalled. Now suggests the full recommended install: `install --with-templates --with-labels --with-skill .`.

## [1.7.1] - 2026-09-22

### Fixed

- **`status`'s suggested update command was missing `--with-labels`**: found while manually updating a consumer repo — the suggested `install --with-templates --with-skill --update .` completed without error but silently left the repo missing the new `delivery-ops-filed` label (1.7.0), since `--update` only replaces workflow/template files and never touches labels. `buildUpdateCommand()` now always appends `--with-labels`, unlike `--with-templates`/`--with-skill` which stay conditional on what's actually installed — safe to make unconditional since `--with-labels` is idempotent, only ever creating labels that don't already exist. This one function backs every "Run:"/"Fix:" hint `status` prints, so the fix applies everywhere at once. `docs/consumer-setup.md`'s `scripts/install.sh` update examples updated to match.

## [1.7.0] - 2026-09-22

### Added

- **`delivery-ops-filed` label**: the only prior signal that an issue's content was auto-generated rather than typed by a person was a footer line buried in the body — not something GitHub can search or filter on. `auto-qa-request.yml` now applies this label (magenta, `D6336C`) alongside `task`/`qa-request` on everything it auto-files, and the `delivery-ops` skill applies it the same way when its autonomous tracking mode files something on its own (never on an issue created at explicit human request). `gh issue list --label delivery-ops-filed` now finds everything self-generated regardless of type. Single-sourced in `.github/scripts/labels.tsv` like every other label. A new label doesn't retroactively apply to issues created before it existed — `docs/consumer-setup.md` documents a one-line backfill command, same pattern as the existing `sprint-active` → `sprint-child` migration note.
- **Pre-flight check: stale-install prompt**: the `delivery-ops` skill's pre-flight check (installed?, labels set up?, repo variables set?) gained a fourth question — up to date? It now compares a target repo's installed version (`.github/delivery-os.json`) against the latest published npm version before doing anything else, and offers to update if it's behind, with the same confirm-first pattern as the existing label-setup fix.
- **README**: the "What you get" table's Claude Code skill row crammed six distinct capabilities into one dense sentence — pulled into their own bullet list, one per capability, matching `SKILL.md`'s own description (create/comment/status/autonomous tracking/spec breakdown/cleanup sweep).

### Fixed

- **Test brittleness**: two tests in `test/install.test.js` hardcoded a "15 labels" count that broke the moment `labels.tsv` gained a 16th entry (`delivery-ops-filed`) — the same class of fragility the `WORKFLOWS.length` fix caught for the workflow count in 1.6.0. Both now derive the expected count from `loadLabels()` instead of a literal.

## [1.6.0] - 2026-09-22

### Added

- **`auto-qa-request` workflow**: files a `QA REQUEST -` issue whenever a PR opens (or leaves draft) or a commit lands directly on `main` — a safety net so a feature can't reach `main` without a QA Request existing for it, whether or not a dev remembered to open one, and whether or not the work went through a PR at all. It's a safety net, not a gate: nothing is blocked. If the PR body references a tracked issue via GitHub's closing keywords (`Closes #N`, `Fixes #N`, etc.), the QA Request links to it and pulls its `### Acceptance Criteria` section through; otherwise a `TASK -` issue is auto-filed first (marked as untracked) and the QA Request links to that instead. Skips push events that are just a PR merge (default merge-commit or squash-commit message shape) landing on `main`, so a normal merge doesn't file a duplicate — this can't detect a rebase-merge the same way, since those carry no reliable marker in the resulting commits. Idempotent per PR/push via a marker line in the QA Request body. New pure logic lives in `.github/scripts/auto-qa-request.js`, unit tested in `test/auto-qa-request.test.js`, and — like every other workflow here — has to be explicitly registered in `src/install.js`'s `WORKFLOWS`/`SCRIPTS` arrays, `scripts/install.sh`'s mirrored lists, and this package's own `files` array to actually reach a consumer repo; all three were updated.
- **Cleanup sweep: "Untouched QA Requests" check**: the `delivery-ops` skill's cleanup sweep now also flags `qa-request` issues still `QA Outcome: Pending` with no recent activity — closes the gap the workflow above can't close on its own (it guarantees a QA Request gets filed, not that anyone acted on it). Flag-only, same reasoning as the existing "Stale Tasks" check.

### Changed

- **`sprint-child` label recolored** from `1D76DB` (same blue as `sprint`) to `1ABC9C` (teal — a distinct hue from every other label color in the palette, not just a shade of blue) — the two were visually indistinguishable in an issue list, making it harder to tell a `SPRINT -` parent issue apart from its `TASK` children at a glance. Only affects newly-created labels; existing repos can pick it up with `gh label edit sprint-child --repo <owner>/<repo> --color 1ABC9C`.

## [1.5.1] - 2026-09-20

### Changed

- **Single source of truth for label definitions**: `setup-labels.yml`, `scripts/install.sh`, and `src/install.js` each kept an independently hand-maintained copy of the label list (name/color/description) — the direct cause of the `src/install.js` gap fixed in 1.5.0, since there was no single place to update, just three copies to remember to keep in sync. All three now read from `.github/scripts/labels.tsv` — plain tab-separated text, not JS/JSON, specifically so `scripts/install.sh` can read it directly with a `read` loop rather than needing an interpreter as a new dependency (`.github/scripts/labels.js` is a thin JS-side parser over that file, used by `setup-labels.yml` and `src/install.js`). `setup-labels.yml` gained an `actions/checkout` step so it can `require()` the parser once installed into a consumer repo (same pattern already used by `auto-close-sprint.yml`/`sprint-child-creator.yml`). No label names, colors, descriptions, or CLI-visible behavior changed. Tracked as [#20](https://github.com/Phaneroo/github-delivery-operating-system/issues/20), closed by this release.

### Fixed

- **`status` false-positive "broken install"**: an earlier commit on this branch added a `'setup-labels': 'labels'` entry to `REQUIRED_SCRIPT_BY_WORKFLOW` without accounting for the fact that, unlike every other entry there, `setup-labels.yml` did *not* require any script before this release — every repo that installed it pre-1.5.1 would have been flagged "⚠️ Broken install detected" the moment this shipped, even though their actually-installed workflow requires nothing and works fine as-is. The static map entry was removed; `status` now checks the *installed* `setup-labels.yml`'s own content for whether it actually references `labels.js` before deciding whether `labels.js`/`labels.tsv` are required — more reliable than an earlier attempt that gated on the manifest's recorded version, which can be stale relative to what's actually on disk (an `--update` run that didn't also pass `--with-templates`/`--with-skill` deliberately leaves the recorded version behind).
- **Unguarded label-definition loading**: both `src/install.js` and `setup-labels.yml`'s inline script now wrap reading `labels.tsv` in a try/catch. The workflow-side failure now also calls `core.setFailed(...)` (not just a log line) so a missing/corrupt `labels.tsv` shows up as a failed Actions run instead of a misleading green checkmark with zero labels created.
- **`scripts/install.sh`**: the label loop had three bugs, one critical. (1) A bare `err=$(gh label create ...)` assignment under `set -e` aborted the *entire installer* on the very first "already exists" — the normal case on any re-run — after creating only 1 of 15 labels, with no error message; pre-existing, not introduced this release, but newly caught once `--with-labels` got its first end-to-end test. (2) The loop read `labels.tsv` on stdin, so `gh label create` inside it would have inherited that file descriptor — now reads from a dedicated fd. (3) `IFS=$'\t' read` doesn't strip whitespace or a CRLF line ending's trailing `\r` the way `labels.js`'s `.trim()` does, and silently dropped the final line if the file lacked a trailing newline — all three fixed with a shared `trim()` helper and a `read ... || [ -n "$name" ]` loop guard.
- **`runUninstall` completeness check**: `anyScriptsRemain` was updated to account for `SCRIPTS_PACKAGE_JSON` but not `LABELS_TSV`, even though `labels.tsv` is unconditionally removed a few lines above it in the same function — the exact asymmetric-completeness bug shape its own comment warns about.
- **`docs/consumer-setup.md`** carried its own hardcoded label table — a fourth independently-maintained copy of exactly what issue #20 was filed to eliminate. Replaced with a link to `.github/scripts/labels.tsv`.

## [1.5.0] - 2026-09-20

### Changed

- **Sprint child label renamed `sprint-active` → `sprint-child`**: the old name never changed when its sprint closed, so a Task issue could carry `sprint-active` long after the sprint it belonged to finished — easy to misread in an issue list as "this sprint is currently active" rather than "this task originated from a sprint's breakdown." Fresh installs and any repo that re-runs `Setup Labels`/`install --with-labels` now get `sprint-child` (with an on-hover description) instead; the label-creation logic previously lived independently in three places (`setup-labels.yml`, `scripts/install.sh`, and `src/install.js` — the last of these had silently drifted out of sync with the other two, missing the description entirely) and all three were updated together. `auto-close-sprint`'s burn-down was already label-independent (scans issue bodies for `Parent Sprint: #N`) so it's unaffected either way. `telegram-issues.yml`'s sprint-task notifications now check both label names, so issues created before a repo upgrades keep notifying correctly. Existing repos are not touched automatically — nothing in this package reaches into an already-installed repo — but `docs/consumer-setup.md` documents a one-line, fully optional `gh label edit sprint-active --name sprint-child` to retroactively rename it across every issue that already has it, in place.
- **`install --overwrite` renamed to `--update`**: matches how it was already described everywhere ("Update Delivery OS", "use --overwrite to replace/update") better than the old name, which read as more destructive than what it actually does. `-o, --overwrite`/`--no-overwrite` keep working as hidden, undocumented aliases in both `npx github-delivery-os install` (`src/cli.js`) and `scripts/install.sh`, so existing scripts/CI calling the old flag don't break. All suggested-command output (`status`'s update hints, broken-install `Fix:` hints) now shows `--update`.

## [1.4.1] - 2026-09-18

### Fixed

- **npm package**: `1.4.0` was published from a local checkout that predated the README shortening in the same day's work — the published tarball's `README.md` (and therefore the rendered npm package page) still carried the old ~360-line content instead of the short version merged shortly after. No code or behavior changed; this release exists solely to get the corrected `README.md` onto the registry, since npm doesn't allow overwriting an already-published version.

## [1.4.0] - 2026-09-18

### Added

- **delivery-ops skill**: turn a spec (SRS/PRD) or a plain-language feature description into a real phase-and-task breakdown filed as actual GitHub issues. Decomposes requirements into phases (each a Sprint Planning issue) and files a full Task issue per requirement — owner/priority/acceptance criteria drawn from the spec — rather than relying on `sprint-child-creator`'s bare auto-created children, which only carry a title. Always shows the full plan for confirmation before creating anything, since this creates many issues at once. Works around the sprint template's required "Sprint Features" field (one placeholder line, whose single auto-created child is closed as superseded once the real Task issues exist to reference) while tagging real Task issues with `Parent Sprint: #N` — the exact phrase `auto-close-sprint`'s burn-down actually scans for — so they're counted correctly. For a small feature that doesn't need phase-level sequencing, files standalone Task issues without the Sprint wrapper.

## [1.3.1] - 2026-09-18

### Fixed

- **status**: all four suggested-command hints ("update available", "unknown version", broken-workflow "Fix:", missing-scripts-package.json "Fix:") always suggested a bare `install --overwrite .`, even for a repo installed with `--with-templates`/`--with-skill`. Running exactly that suggested command leaves those files present-but-untouched, and `install`'s own `cleanInstall` check then refuses to advance the recorded manifest version — so `status` kept reporting the same stale version and suggesting the same broken command indefinitely, with no way out except reading the source. All four hints now include `--with-templates`/`--with-skill` whenever `status` detects those are actually installed.

## [1.3.0] - 2026-09-17

### Added

- **delivery-ops skill**: autonomous task tracking. Beyond filing one issue on request, the skill can now run a piece of work's whole lifecycle — notice it, classify it (Task / Bug / Sprint / QA / Production Release), file it, keep its `### Status` field and comments in sync as work happens, and close it out with a summary. Acts without asking when the classification and outcome are clear, always posting a one-line in-session notice ("Filed #23...", "Updated #17 to In Progress", "Closed #17..."); asks first only when genuinely ambiguous (unclear category, unclear which existing issue it maps to, unclear whether it's actually done). Introduces no new issue types or automation — a "phase" is a Sprint Planning issue (children linked via `Parent Sprint: #N`, same as `sprint-child-creator`), and a "roadmap" is a single persistent issue Claude keeps rewritten to list phases and their state. Reconciles against `gh issue list` at the start of relevant work rather than relying on memory, so picking work back up in a new session doesn't need any local state.

### Known limitation

- Autonomous tracking only reacts while a Claude session is actively working — nothing reconciles state that changes in the background (a human merging a PR or closing an issue with no session running). Deferred deliberately rather than solved now; tracked as [#12](https://github.com/Phaneroo/github-delivery-operating-system/issues/12).

## [1.2.2] - 2026-09-16

### Fixed

- **Critical:** `.github/scripts/*.js` (the `require()`-based logic behind `authorize-deployment.yml`, `auto-close-sprint.yml`, and `sprint-child-creator.yml`) is CommonJS, but a consumer repo whose own `package.json` has `"type": "module"` makes Node treat every `.js` file in the repo as an ES module by default — including these — breaking `require()`/`module.exports` at runtime with `ReferenceError: module is not defined in ES module scope`. Found live against a real `"type": "module"` consumer repo: `sprint-child-creator` failed on open, silently producing zero child issues instead of the expected one per feature line. Fixed by shipping a `.github/scripts/package.json` (`{"type": "commonjs"}`) alongside the scripts — Node resolves module type from the nearest `package.json`, so this pins the scripts subtree to CommonJS regardless of the consumer repo's own root config. Installed and removed by both the npm CLI and `scripts/install.sh`, same as the scripts themselves; `status` now also detects and reports an install missing this file as broken, with the fix command.

## [1.2.1] - 2026-09-16

### Fixed

- **Critical:** `.github/scripts/*.js` — the pure logic `authorize-deployment.yml`, `auto-close-sprint.yml`, and `sprint-child-creator.yml` `require()` at runtime (added in 1.1.0) — was never included in what actually ships (not in `package.json`'s `files`, not copied by `install.js`, not copied by `scripts/install.sh`). Every fresh install via `1.1.0` or `1.2.0` got those three workflows installed successfully, but the first time one actually ran, it crashed with `MODULE_NOT_FOUND`, breaking dual-approval authorization, sprint auto-close, and sprint child creation. Found by an independent retroactive code-review pass, confirmed against the live published package. Fixed in the npm CLI, the shell-script installer, and `package.json`. `status` now also detects and reports this exact broken state (workflow present, required script missing) for anyone already affected, with the fix command; simply re-running `install` (no `--overwrite` needed, since the scripts were never there to begin with) self-heals an already-broken install.
- **install/status**: `--overwrite` without `--with-templates`/`--with-skill` used to claim a fully "clean" install even when templates or the skill already existed on disk from an earlier install and were left untouched — `status` would then report "up to date" for files that, in fact, were still at the old version.
- **uninstall**: the version manifest was removed unconditionally, even when templates or the skill were deliberately kept (no `--with-templates`/`--with-skill` on uninstall) — a later `status` would then report "unknown version" for files that were still fully present and accurately version-tracked. Now only removed once nothing Delivery-OS-related actually remains.
- **auto-close-sprint**: reverted the `sprint-active` label scoping added in 1.2.0 (a premature optimization) — it could silently drop a child issue that got relabeled away from `sprint-active` while still open out of the progress calculation entirely, inflating progress or even falsely reaching 100% and auto-closing the sprint. Back to the documented, body-content-based trigger.
- **authorize-deployment**: the per-issue concurrency group added in 1.2.0 didn't actually prevent duplicate status comments the way its own comment claimed — the "already posted?" check read a label snapshot fixed at the triggering comment's delivery time, which serializing execution order doesn't refresh. Now re-fetches labels live before deciding, and only does so when there's an actual verdict to act on (not on every routine comment on a production issue).
- **authorize-deployment**: `addLabels` calls are now wrapped in `try`/`catch` (matching `removeLabel`, which already was) — a transient API failure right after removing the opposing label no longer leaves the issue with neither label and no comment posted.
- **telegram-issues**: the release-approved alert only matched comments starting with "approved", missing "approve"/"ok"/"go ahead" — a release could be genuinely approved with no Telegram alert sent for it. Now matches the same keyword set `authorize-deployment.yml` actually uses, including the same word-boundary anchoring (so "okay, I'll look at this tomorrow" no longer falsely triggers a "RELEASE APPROVED" alert).
- **auto-close-sprint.js**: `computeTimePercent` divided by zero (producing `NaN`) when a sprint's Start and End dates were the same, reversed, *or unparseable* (e.g. an out-of-range date typo like `2026-13-05`, which matches the `YYYY-MM-DD` shape but produces an Invalid Date) — the posted burn-down would read "Time Elapsed: NaN%" with the health emoji silently defaulting to green instead of flagging the broken dates.
- **install.js**: a workflow or script whose source file is unexpectedly missing (a packaging error — exactly the class of bug this release fixes) is now counted toward the install being non-clean, instead of only printing a warning while still recording a "fully synced" manifest version.
- **status**: the "is anything installed" checks now account for the Claude Code skill — a repo with only the skill present (no workflows/templates) no longer incorrectly reports "Delivery OS is not installed."
- **uninstall**: the "is anything left?" check that decides whether to remove the manifest now also accounts for scripts, for consistency with workflows/templates/skill (scripts are already always removed, so this was latent rather than reachable, but is now complete rather than assumed).

### Changed

- `install.js`'s and `scripts/install.sh`'s near-duplicate copy loops for workflows and scripts (found by an independent review as a maintenance risk — "it's easy to update one copy and forget the other," which had in fact already happened once between the two files during this same fix) are now a single shared helper each, used by both.

## [1.2.0] - 2026-09-15

### Added

- New opt-in `--with-skill` flag on `install`, `status`, and `uninstall`. `install --with-skill` writes `.claude/skills/delivery-ops/SKILL.md` into the target repo — a [Claude Code](https://claude.com/claude-code) skill for operating that repo's Delivery OS from Claude Code (creating sprint/production-release/QA-request/bug/task issues in the shape the workflows parse, commenting as an approver with the recognized keyword conventions, checking status). Never written unless asked for; retroactively addable by re-running `install --with-skill` later, same as `--with-templates`. `status` reports whether it's installed; `uninstall --with-skill` removes it (kept by default, like templates).

## [1.1.0] - 2026-09-11

### Added

- `delivery-os status` now reports the installed version and checks npm for a newer release, printing the exact update command when behind (`--offline` skips the check; never fails the command if npm is unreachable)
- Installs via `npx github-delivery-os` now write `.github/delivery-os.json`, a manifest recording the installed version — only when the on-disk files actually match it (fresh install, or `--overwrite`); a skip-mode install over existing files leaves it untouched instead of misreporting the version. `uninstall` removes it.

### Fixed

- **authorize-deployment**: a release approver's decline no longer permanently blocks future approval — the workflow now tracks the *latest* verdict from their comments instead of stopping at the first decline found
- **authorize-deployment**: approve/decline keyword matching is now anchored to the start of the comment with a word boundary, so it no longer false-triggers on substrings inside unrelated sentences (e.g. "okay" no longer matches "ok", "rejection" no longer matches "reject", "not approved" appearing mid-sentence no longer declines a release) — including "rejected" (past tense), which the anchoring initially broke and was caught by review before merge
- **authorize-deployment**: runs are now serialized per issue (`concurrency` group), so a decline immediately corrected with an approval can no longer trigger two overlapping runs that both post a status comment
- **authorize-deployment** / **telegram-issues**: approver login/actor comparisons are now case-insensitive
- **telegram-issues**: decline detection is now anchored to the start of the comment, matching authorize-deployment's actual decision logic, so it can no longer announce a decline that didn't really happen
- **auto-close-sprint**: runs are now serialized per repo (`concurrency` group) to prevent races when multiple child issues close in quick succession
- **auto-close-sprint**: burn-down/progress calculation now paginates through all repo issues instead of only the first 100, which previously undercounted sprint children in larger repos — scoped to the `sprint-active` label rather than every issue in the repo, since this now runs on every child close
- **auto-assign-qa**: `pozil/auto-assign-issue` pinned to a commit SHA instead of the mutable `v1` tag
- **cli**: `status` now uses `parseAsync` instead of `parse`, so an error inside it can no longer silently exit 0 on Node <15

### Changed

- The pure decision logic in `authorize-deployment`, `auto-close-sprint`, and `sprint-child-creator` (verdict computation, burn-down/health math, sprint-date parsing, feature-list parsing) has been extracted from the inline workflow scripts into `.github/scripts/*.js`, each required by its workflow and covered by a new dependency-free test suite (`test/`, `npm test`) — previously this logic only existed as a string inside YAML, unreachable by any automated test. `authorize-deployment`, `auto-close-sprint`, and `sprint-child-creator` each gained an `actions/checkout` step (needed for the `require()`) and `contents: read` permission.

## [1.0.3] - 2026-03-31

### Changed

- Package metadata (`repository`, `homepage`, `bugs`) and docs now point at the **Phaneroo** GitHub org after the repo transfer (npm registry page updates on publish).

## [1.0.2] - 2026-03-17

### Added

- `delivery-os status` — show which workflows and templates are installed
- `delivery-os uninstall` — remove workflows (optionally templates with `--with-templates`)
- `CHANGELOG.md` for version history
- GitHub release workflow (triggered on tag push)
- Refined npm keywords for discoverability

## [1.0.1] - 2026-03-17

### Security

- Replace `execSync` with `execFileSync` for gh CLI calls to avoid shell access (resolves Socket security analysis warning)

## [1.0.0] - 2026-03-17

### Added

- Initial release
- `delivery-os install` with `--with-templates`, `--with-labels`, `--overwrite`, `--dry-run`
- 7 GitHub Actions workflows: sprint-child-creator, auto-close-sprint, notify-release-approver, authorize-deployment, auto-assign-qa, telegram-issues, setup-labels
- 6 issue templates: sprint planning, task, bug report, QA request, production release, config
- npm package publish
