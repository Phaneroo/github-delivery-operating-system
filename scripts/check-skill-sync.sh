#!/usr/bin/env bash
# Checks that .claude/skills/delivery-ops/SKILL.md (the copy bundled into this
# npm package, shipped via `install --with-skill`) matches the canonical copy
# in the jkaweesi22/KaweesiSkills repo. The two exist in separate repos, one
# public, one private — that repo is private, so this can't run as a CI
# check (CI runners have no credentials for it); it's a local, maintainer-run
# check instead. Uses whatever `gh` auth is already active in this shell.
#
# Usage: scripts/check-skill-sync.sh
# Exit 0 if the two copies match, 1 if they've diverged or the canonical copy
# couldn't be fetched.

set -euo pipefail

LOCAL_PATH=".claude/skills/delivery-ops/SKILL.md"
CANONICAL_REPO="jkaweesi22/KaweesiSkills"
CANONICAL_PATH="delivery-ops/SKILL.md"

if [ ! -f "$LOCAL_PATH" ]; then
  echo "error: $LOCAL_PATH not found. Run this from the repo root." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi

TMP_CANONICAL="$(mktemp)"
trap 'rm -f "$TMP_CANONICAL"' EXIT

if ! gh api "repos/${CANONICAL_REPO}/contents/${CANONICAL_PATH}" --jq '.content' 2>/dev/null \
  | base64 -d > "$TMP_CANONICAL" 2>/dev/null; then
  echo "error: could not fetch ${CANONICAL_REPO}/${CANONICAL_PATH}." >&2
  echo "       Check 'gh auth status' and that this account has read access to that (private) repo." >&2
  exit 1
fi

if diff -q "$LOCAL_PATH" "$TMP_CANONICAL" >/dev/null; then
  echo "✓ $LOCAL_PATH matches the canonical copy in ${CANONICAL_REPO}."
  exit 0
else
  echo "✗ $LOCAL_PATH has DRIFTED from the canonical copy in ${CANONICAL_REPO}."
  echo ""
  echo "Diff (local vs. canonical):"
  diff "$LOCAL_PATH" "$TMP_CANONICAL" || true
  echo ""
  echo "Fix: decide which side is correct, then copy that version over the other."
  exit 1
fi
