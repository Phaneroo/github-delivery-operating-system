---
name: release
description: Ship a change to github-delivery-os — version bump, CHANGELOG entry, docs-sync sweep, validation, PR. Stops before merge/tag/publish for explicit confirmation. Use when preparing a release, or asked to "ship this", "cut a release", "prep a release PR" for this repo.
---

# Release github-delivery-os

Use this after a fix or feature is implemented and already verified, when it's time to package it up and ship it — not for deciding what to fix. Bug-hunting and implementation are ordinary work done before invoking this skill; this skill is the repeatable checklist for turning finished, verified changes into a released version.

## Scope

This automates the mechanical, repeatable parts of a release. It does **not** execute the merge, the tag push, or `npm publish` — those are irreversible public actions (a public GitHub Release, a public npm version) and stay explicit, user-confirmed steps at the end. Do not run them without being asked, even if everything up to that point went smoothly.

## Steps

1. **Confirm branch.** `main` is the default branch — changes must be on a feature branch, never committed straight to `main`. If currently on `main`, create one (e.g. `fix/<short-description>` or `feat/<short-description>`).

2. **Determine the version bump.** Ask the user if it's not obvious, or infer from the diff:
   - `patch` — bug fixes only, no new user-facing behavior
   - `minor` — new CLI flags/commands, new workflow behavior, additive changes
   - `major` — breaking changes to CLI flags, to installed file names/locations, or to workflow behavior existing installs depend on

   Bump the `version` field in `package.json` accordingly.

3. **Sync `package-lock.json`.** Run `npm install` (no dependency changes expected — this only updates the lockfile's own `name`/`version` fields to match `package.json`). This repo has shipped with a stale lockfile version before (the 1.1.0 release fixed a lockfile still reading `1.0.3`); don't skip this step.

4. **Draft the CHANGELOG entry.** Add a new `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md` (today's date), following the existing `Added` / `Fixed` / `Changed` grouping style already used there. Base it on the actual diff and `git log <last-tag>..HEAD`, not just the most recent commit — if more commits land on the branch after the entry is first drafted, revisit it before opening (or before merging) the PR so it still matches the full diff. This was missed once this session and needed a manual catch-up pass.

5. **Docs-sync sweep.** Grep for anything the diff touches that's also documented, and flag anything gone stale rather than leaving it silently wrong:
   - CLI commands/flags → `README.md`, `docs/consumer-setup.md`, `docs/how-to.md`
   - Workflow behavior/triggers → `docs/governance.md`, `docs/architecture.md`
   - New files written into a consumer repo (e.g. a new manifest, a new template) → README's "What Gets Installed" table and `docs/consumer-setup.md`

   `grep -rn "npx github-delivery-os\|delivery-os \(status\|uninstall\|install\)" README.md docs/*.md` is a reasonable starting point for command references. This was missed twice in the 1.1.0 release before being made an explicit step — `docs/consumer-setup.md`'s "Uninstalling" section documented manual file deletion for a long time after the `uninstall` CLI command already existed.

6. **Validate before committing:**
   - `npm test` — must pass (`test/run.js`, plain `assert`, no framework)
   - Every touched `.yml`: `npx --yes js-yaml <file>` — catches YAML syntax errors before they reach a real workflow run
   - Every touched `.js`, **including files `require()`'d from inside a workflow's inline `actions/github-script` block**: `node --check <file>`
   - If a workflow's inline script itself changed (not just a file it requires), extract the `script: |` block from the YAML, wrap it in an async function, and `node --check` it — YAML validity alone doesn't catch JS syntax errors inside the string. For anything beyond a syntax check — actually exercising the logic — see the note on end-to-end verification below.
   - If a workflow now `require()`s a file from `.github/scripts/`, confirm it has an `actions/checkout` step and `contents: read` permission — `require()`ing a repo file needs the repo checked out first, and a workflow with an explicit `permissions:` block defaults every unlisted scope to `none`.

7. **Commit and push.** Write commit messages that explain *why*, not just what — especially for anything that was a real bug fix, note the failure scenario it closes. Push the branch.

8. **Open the PR.** `gh pr create` with a structured description: Summary (grouped by area if there's more than one), and a Verification section listing what was *actually* checked — tests passed, CI status, specific scenarios exercised — not just "should work."

9. **Check CI and keep it current.** `gh pr checks <number>` — wait for it to resolve rather than handing back control while it's still pending. If more commits land on the branch after opening the PR (follow-up fixes, review responses), update the PR description and the CHANGELOG entry to still match the full diff before considering the PR ready — both went stale mid-session here and needed a dedicated catch-up pass.

10. **Stop. Report the PR link and a summary. Do not merge, tag, or publish without being explicitly asked** — treat each as its own separate go-ahead, even if the user approved an earlier one in the same conversation:
    - **Merge:** `gh pr merge <number> --merge --delete-branch`. Prefer a merge commit over squash when the branch's individual commits each document a distinct, meaningful change — squashing loses that.
    - **Tag:** `git tag vX.Y.Z` (safe, local-only) can be done proactively once asked to start the release. Pushing it (`git push origin vX.Y.Z`) triggers `release.yml` and creates a public GitHub Release — Claude Code's permission system may refuse this as a "Create Public Surface" action even after `git tag` succeeded; if so, don't try to work around it, tell the user and let them run `git push origin vX.Y.Z` themselves.
    - **Publish:** `npm publish` needs `npm login` first if the session isn't authenticated (check with `npm whoami`). `npm login` is interactive (browser or username/password/OTP) — tell the user to run `!npm login` themselves in the prompt rather than attempting it via Bash, since a backgrounded/non-interactive attempt will just fail waiting for input. After confirming `npm whoami` succeeds, also sanity-check with `npm view github-delivery-os version` before publishing — the published version might already match if the user ran `npm publish` themselves in parallel.

## Repo-specific reference

- Tests: `npm test` → `test/run.js`, which `require()`s each `test/*.test.js` file (register cases via `test('name', fn)` from `test/harness.js`) and prints a pass/fail summary.
- Pure logic that used to live only as strings inside workflow YAML has been extracted to `.github/scripts/*.js` (see `authorize-deployment-verdict.js`, `auto-close-sprint.js`, `sprint-child-creator.js`) specifically so it's unit-testable — when adding new non-trivial logic to a workflow's inline script, prefer extracting it the same way rather than growing the inline string.
- `release.yml` and `ci.yml` both run `npm test` — a red check on a PR means the actual release would fail too, not just a lint nag.
- For end-to-end confidence beyond a syntax check — proving a workflow's inline script still wires up correctly after a change — extract the actual `script: |` text from the YAML (byte-for-byte, via a small regex script, not retyped by hand) and run it against mocked `github`/`context`/`fetch` objects for a few realistic scenarios. This has caught real issues that unit tests on the extracted pure functions alone didn't (e.g. confirming `require()` resolves correctly, confirming the right `addLabels`/`createComment` calls happen for a given verdict).
