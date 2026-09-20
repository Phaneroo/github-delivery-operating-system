#!/usr/bin/env bash
# GitHub Delivery Operating System — Installer
# Copies workflows and templates directly (Phanerooapp-style).
# Default: skip existing files (safe). Use --update to replace.

set -e

# Copies each "<name><ext>" from src_dir to dest_dir for a fixed list of
# expected filenames — the shared logic behind copying workflows and
# scripts (both: a required, always-on set of individually-named files).
# Sets COPIED to the result (bash has no clean multi-value return).
# Usage: copy_managed_files "name1 name2 ..." ext src_dir dest_dir rel_dir
copy_managed_files() {
  local names="$1" ext="$2" src_dir="$3" dest_dir="$4" rel_dir="$5"
  COPIED=0
  for name in $names; do
    local src="${src_dir}/${name}${ext}"
    local dest="${dest_dir}/${name}${ext}"
    local label="${rel_dir}/${name}${ext}"
    if [ ! -f "$src" ]; then
      echo "  Warning: source not found: ${label}"
      continue
    fi
    if [ -f "$dest" ] && [ "$OVERWRITE" != "true" ]; then
      echo "  Skipped (exists): ${label}"
    elif [ "$DRY_RUN" = "true" ]; then
      echo "  [dry-run] Would create: ${label}"
      COPIED=$((COPIED + 1))
    else
      cp "$src" "$dest"
      echo "  Created: ${label}"
      COPIED=$((COPIED + 1))
    fi
  done
}

usage() {
  echo "Usage: $0 [options] [target_dir]"
  echo ""
  echo "Options:"
  echo "  --with-templates   Copy issue templates"
  echo "  --with-labels      Create labels via gh CLI"
  echo "  --update           Replace existing workflows/templates (default: skip)"
  echo "  --no-update        Explicitly skip existing files (default behavior)"
  echo "  --dry-run          Show what would happen without changing files"
  echo "  -h, --help         Show this help"
  echo ""
  echo "Default: existing files are NOT overwritten. Use --update to replace."
}

# Parse args: [--with-templates] [--with-labels] [--update|--no-update] [--dry-run] [target_dir]
# Default: skip existing files (safe). Use --update to replace.
TARGET_DIR="."
WITH_TEMPLATES=false
WITH_LABELS=false
OVERWRITE=false
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --with-templates) WITH_TEMPLATES=true; shift ;;
    --with-labels) WITH_LABELS=true; shift ;;
    --update) OVERWRITE=true; shift ;;
    --no-update) OVERWRITE=false; shift ;;
    # Pre-1.5.0 names, kept working silently (not shown in usage()) so
    # existing scripts/CI calling this installer don't break.
    --overwrite) OVERWRITE=true; shift ;;
    --no-overwrite) OVERWRITE=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) TARGET_DIR="$1"; shift ;;
  esac
done

# Resolve paths (script can be run from any directory)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOWS_SRC="${REPO_ROOT}/.github/workflows"
TEMPLATES_SRC="${REPO_ROOT}/.github/ISSUE_TEMPLATE"
SCRIPTS_SRC="${REPO_ROOT}/.github/scripts"
TARGET_ABS="$(cd "$TARGET_DIR" && pwd)"

echo "=== GitHub Delivery Operating System ==="
echo "Target: ${TARGET_ABS}"
if [ "$OVERWRITE" = "true" ]; then
  echo ""
  echo "⚠️  WARNING: Overwrite mode — existing Delivery OS workflows/templates will be REPLACED."
  echo "    (Your other workflows/templates with different names are not affected.)"
  echo ""
elif [ "$DRY_RUN" = "true" ]; then
  echo "Mode: dry-run (no files will be changed)"
  echo ""
else
  echo "Mode: skip-existing (existing workflows/templates will NOT be overwritten)"
  echo ""
fi

# 1. Ensure target .github structure
mkdir -p "${TARGET_ABS}/.github/workflows"
mkdir -p "${TARGET_ABS}/.github/ISSUE_TEMPLATE"
mkdir -p "${TARGET_ABS}/.github/scripts"

# 2. Copy workflows
WORKFLOWS="sprint-child-creator auto-close-sprint notify-release-approver authorize-deployment auto-assign-qa telegram-issues setup-labels"
copy_managed_files "$WORKFLOWS" ".yml" "$WORKFLOWS_SRC" "${TARGET_ABS}/.github/workflows" ".github/workflows"
WORKFLOWS_COPIED=$COPIED

# 2b. Copy the scripts some workflows require() at runtime — required, not
# optional, so (like workflows) this always runs.
SCRIPTS="authorize-deployment-verdict auto-close-sprint sprint-child-creator labels"
copy_managed_files "$SCRIPTS" ".js" "$SCRIPTS_SRC" "${TARGET_ABS}/.github/scripts" ".github/scripts"
SCRIPTS_COPIED=$COPIED

# 2c. Copy single extra files that travel alongside the scripts above but
# aren't themselves ".js": the CommonJS-pinning package.json (without it, a
# target repo whose own package.json has "type": "module" makes Node treat
# these .js files as ES modules too, breaking require() with "module is not
# defined in ES module scope") and labels.tsv (the data file labels.js, just
# copied above, parses). Counted together with the scripts above.
for extra in "package:.json" "labels:.tsv"; do
  extra_name="${extra%%:*}"
  extra_ext="${extra#*:}"
  copy_managed_files "$extra_name" "$extra_ext" "$SCRIPTS_SRC" "${TARGET_ABS}/.github/scripts" ".github/scripts"
  SCRIPTS_COPIED=$((SCRIPTS_COPIED + COPIED))
done

# 3. Optionally copy issue templates
TEMPLATES_COPIED=0
if [ "$WITH_TEMPLATES" = true ]; then
  if [ -d "$TEMPLATES_SRC" ]; then
  for tpl in "$TEMPLATES_SRC"/*.yml; do
    [ -f "$tpl" ] || continue
    name=$(basename "$tpl")
    dest="${TARGET_ABS}/.github/ISSUE_TEMPLATE/${name}"
    if [ -f "$dest" ] && [ "$OVERWRITE" != "true" ]; then
      echo "  Skipped (exists): ${name}"
    elif [ "$DRY_RUN" = "true" ]; then
      echo "  [dry-run] Would create template: ${name}"
      TEMPLATES_COPIED=$((TEMPLATES_COPIED + 1))
    else
      cp "$tpl" "$dest"
      echo "  Created template: ${name}"
      TEMPLATES_COPIED=$((TEMPLATES_COPIED + 1))
    fi
  done
  fi
fi

# 4. Optionally create labels via gh CLI. Definitions live in
# .github/scripts/labels.tsv — the single source of truth also read by
# setup-labels.yml and src/install.js — plain tab-separated text (not
# JS/JSON) specifically so this can read it directly with `read`, without
# needing node or any other interpreter as a dependency.
LABELS_CREATED=0
LABELS_SKIP_REASON=""
if [ "$WITH_LABELS" = true ]; then
  LABELS_TSV_FILE="${SCRIPTS_SRC}/labels.tsv"
  if [ "$DRY_RUN" = "true" ]; then
    LABELS_SKIP_REASON="Skipped in dry-run."
    echo "  [dry-run] Labels would be created (skipped)"
  elif ! command -v gh &>/dev/null; then
    LABELS_SKIP_REASON="gh CLI not installed. Install from https://cli.github.com/"
    echo "  Skipped labels: $LABELS_SKIP_REASON"
  elif [ ! -f "$LABELS_TSV_FILE" ]; then
    LABELS_SKIP_REASON="Missing ${LABELS_TSV_FILE}."
    echo "  Skipped labels: $LABELS_SKIP_REASON"
  elif [ ! -d "${TARGET_ABS}/.git" ]; then
    LABELS_SKIP_REASON="Target is not a git repository."
    echo "  Skipped labels: $LABELS_SKIP_REASON"
  else
    if ! (cd "$TARGET_ABS" && gh auth status &>/dev/null); then
      LABELS_SKIP_REASON="gh CLI not authenticated. Run: gh auth login"
      echo "  Skipped labels: $LABELS_SKIP_REASON"
    elif ! (cd "$TARGET_ABS" && gh repo view &>/dev/null); then
      LABELS_SKIP_REASON="Target repo not on GitHub or no push access."
      echo "  Skipped labels: $LABELS_SKIP_REASON"
    else
      # Read from fd 3, not stdin (fd 0): `gh label create` runs inside this
      # loop body and would otherwise inherit the still-open labels.tsv file
      # as its own stdin — harmless today, but if gh ever reads from stdin
      # (an unexpected prompt, a future version change), it would consume
      # bytes meant for this loop's remaining lines, silently truncating the
      # label list with no error.
      while IFS=$'\t' read -r name color desc <&3; do
        # Skip a stray blank-ish line (spaces, no tabs) the same way
        # labels.js's `.trim().filter(Boolean)` does — without this,
        # IFS=$'\t' alone doesn't strip spaces, so a whitespace-only line
        # would pass `[ -z "$name" ]` and attempt
        # `gh label create "   " --color ""`. Checks non-destructively (does
        # not overwrite $name) so a legitimate name is never mangled.
        [ -z "${name//[[:space:]]/}" ] && continue
        # Strip a trailing \r (CRLF checkout — no .gitattributes commits this
        # repo to LF beyond the pin on labels.tsv itself, and a general git
        # clone on Windows with core.autocrlf=true would otherwise land one
        # here). IFS=$'\t' only splits on tabs, so a \r from the line ending
        # lands on whichever field `read` captures last (color on a
        # 2-field line, desc on a 3-field one) — labels.js's `.trim()` is
        # immune to this the same way it is to the whitespace-only case
        # above, so this keeps both parsers of the shared file in sync.
        color="${color%$'\r'}"
        desc="${desc%$'\r'}"
        cmd=(gh label create "$name" --color "$color")
        if [ -n "$desc" ]; then
          cmd+=(--description "$desc")
        fi
        # `if err=$(...); then` (not a bare `err=$(...)` statement followed
        # by a separate `if [ $? -eq 0 ]`) deliberately: under `set -e`, a
        # failing command substitution used as a plain assignment statement
        # aborts the whole script immediately — which for `gh label create`
        # means the very first "already exists" (the normal case on any
        # re-run) would kill the installer before any later label is even
        # attempted, with no message. Guarding the assignment as an `if`
        # condition is bash's documented exemption from that.
        if err=$(cd "$TARGET_ABS" && "${cmd[@]}" 2>&1); then
          echo "  Created label: $name"
          LABELS_CREATED=$((LABELS_CREATED + 1))
        elif echo "$err" | grep -qi "already exists"; then
          echo "  Skipped (exists): $name"
        else
          echo "  Failed to create label '$name': $err"
        fi
      done 3< "$LABELS_TSV_FILE"
    fi
  fi
fi

echo ""
if [ $WORKFLOWS_COPIED -gt 0 ] || [ $TEMPLATES_COPIED -gt 0 ] || [ $SCRIPTS_COPIED -gt 0 ] || [ $LABELS_CREATED -gt 0 ]; then
  if [ "$DRY_RUN" = "true" ]; then
    [ $WORKFLOWS_COPIED -gt 0 ] && echo "Would install ${WORKFLOWS_COPIED} workflow(s)."
    [ $TEMPLATES_COPIED -gt 0 ] && echo "Would copy ${TEMPLATES_COPIED} issue template(s)."
    [ $SCRIPTS_COPIED -gt 0 ] && echo "Would install ${SCRIPTS_COPIED} supporting script(s)."
  else
    [ $WORKFLOWS_COPIED -gt 0 ] && echo "Installed ${WORKFLOWS_COPIED} workflow(s)."
    [ $TEMPLATES_COPIED -gt 0 ] && echo "Copied ${TEMPLATES_COPIED} issue template(s)."
    [ $SCRIPTS_COPIED -gt 0 ] && echo "Installed ${SCRIPTS_COPIED} supporting script(s)."
    [ $LABELS_CREATED -gt 0 ] && echo "Created ${LABELS_CREATED} label(s)."
  fi
  echo ""
  echo "Next steps:"
  echo "  1. Create labels: Actions → Setup Labels → Run workflow"
  [ -n "$LABELS_SKIP_REASON" ] && echo "     (Labels skipped: $LABELS_SKIP_REASON)"
  echo "  2. Configure repo variables (Settings → Secrets and variables → Actions):"
  echo "     - RELEASE_APPROVER: GitHub username of release approver"
  echo "     - QA_APPROVER: GitHub username of QA approver"
  echo "     - QA_ASSIGNEES: Comma-separated usernames for QA assignment"
  echo "  3. Add secrets (optional, for Telegram): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
  if [ "$WITH_TEMPLATES" = false ]; then
    echo "  4. Copy templates: re-run with --with-templates"
  fi
  echo ""
  echo "See docs/consumer-setup.md for full configuration."
else
  if [ "$DRY_RUN" = "true" ]; then
    echo "Dry run complete. No files were changed."
  else
    echo "No new files created (existing files were skipped)."
    echo "To update: use --update (run with --dry-run first to preview)."
  fi
fi
echo ""
echo "=== Installation complete ==="
