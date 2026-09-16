# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
