# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
