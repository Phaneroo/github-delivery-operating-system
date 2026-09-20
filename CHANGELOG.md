# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2026-09-20

### Changed

- **Single source of truth for label definitions**: `setup-labels.yml`, `scripts/install.sh`, and `src/install.js` each kept an independently hand-maintained copy of the label list (name/color/description) — the direct cause of the `src/install.js` gap fixed in 1.5.0, since there was no single place to update, just three copies to remember to keep in sync. All three now read from `.github/scripts/labels.tsv` — plain tab-separated text, not JS/JSON, specifically so `scripts/install.sh` can read it directly with a `read` loop rather than needing an interpreter as a new dependency (`.github/scripts/labels.js` is a thin JS-side parser over that file, used by `setup-labels.yml` and `src/install.js`). `setup-labels.yml` gained an `actions/checkout` step so it can `require()` the parser once installed into a consumer repo (same pattern already used by `auto-close-sprint.yml`/`sprint-child-creator.yml`). No label names, colors, descriptions, or CLI-visible behavior changed. Tracked as [#20](https://github.com/Phaneroo/github-delivery-operating-system/issues/20), closed by this release.

### Fixed

- **`status` false-positive "broken install"**: an earlier commit on this branch added a `'setup-labels': 'labels'` entry to `REQUIRED_SCRIPT_BY_WORKFLOW` without accounting for the fact that, unlike every other entry there, `setup-labels.yml` did *not* require any script before this release — every repo that installed it pre-1.5.1 would have been flagged "⚠️ Broken install detected" the moment this shipped, even though their actually-installed workflow requires nothing and works fine as-is. Caught by code review before merge; the entry was removed rather than special-cased, since a static workflow-name → required-script mapping can't safely express "this workflow started requiring a script partway through its own history."
- **Unguarded label-definition loading**: both `src/install.js` and `setup-labels.yml`'s inline script now wrap reading `labels.tsv` in a try/catch, printing the same graceful "Skipped labels: ..." (or the workflow-side equivalent) used for every other label precondition, instead of crashing with a raw stack trace if the file is ever missing or corrupt.
- **`scripts/install.sh` label loop reading `labels.tsv` on stdin**: `gh label create` runs inside that loop's body and would have inherited the still-open data file as its own stdin — harmless in practice today, but a latent risk if `gh` ever reads from stdin (an unexpected prompt, a future version change), which would silently truncate the label list mid-run with no error. Now reads from a dedicated file descriptor instead.
- **Whitespace-only line handling divergence**: a stray blank-ish line in `labels.tsv` (spaces, no tabs) would pass `scripts/install.sh`'s empty-name check and attempt `gh label create "   " --color ""`, while `labels.js`'s `.trim()` silently drops the same line — a real inconsistency between the "single source of truth" consumers this release exists to unify. Fixed non-destructively (does not alter legitimate label names).
- **`runUninstall` completeness check**: `anyScriptsRemain` (used to decide whether it's safe to also delete the version manifest) was updated to account for `SCRIPTS_PACKAGE_JSON` but not `LABELS_TSV`, even though `labels.tsv` is unconditionally removed a few lines above it in the same function — the exact asymmetric-completeness bug shape its own comment warns about.

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
