#!/usr/bin/env bash
# GitHub Delivery Operating System — Installer
# Copies workflows and templates directly (Phanerooapp-style).
# Default: skip existing files (safe). Use --overwrite to replace.

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
  echo "  --overwrite        Replace existing workflows/templates (default: skip)"
  echo "  --no-overwrite     Explicitly skip existing files (default behavior)"
  echo "  --dry-run          Show what would happen without changing files"
  echo "  -h, --help         Show this help"
  echo ""
  echo "Default: existing files are NOT overwritten. Use --overwrite to replace."
}

# Parse args: [--with-templates] [--with-labels] [--overwrite|--no-overwrite] [--dry-run] [target_dir]
# Default: skip existing files (safe). Use --overwrite to replace.
TARGET_DIR="."
WITH_TEMPLATES=false
WITH_LABELS=false
OVERWRITE=false
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --with-templates) WITH_TEMPLATES=true; shift ;;
    --with-labels) WITH_LABELS=true; shift ;;
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
SCRIPTS="authorize-deployment-verdict auto-close-sprint sprint-child-creator"
copy_managed_files "$SCRIPTS" ".js" "$SCRIPTS_SRC" "${TARGET_ABS}/.github/scripts" ".github/scripts"
SCRIPTS_COPIED=$COPIED

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

# 4. Optionally create labels via gh CLI (must match setup-labels.yml)
LABELS_CREATED=0
LABELS_SKIP_REASON=""
if [ "$WITH_LABELS" = true ]; then
  if [ "$DRY_RUN" = "true" ]; then
    LABELS_SKIP_REASON="Skipped in dry-run."
    echo "  [dry-run] Labels would be created (skipped)"
  elif ! command -v gh &>/dev/null; then
    LABELS_SKIP_REASON="gh CLI not installed. Install from https://cli.github.com/"
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
      LABELS=(
        "intake:0E8A16"
        "bug:D93F0B"
        "sprint:1D76DB"
        "sprint-active:1D76DB"
        "planning:5319E7"
        "sprint-planning:5319E7"
        "task:7057FF"
        "qa:FBCA04"
        "qa-request:FBCA04"
        "production:D93F0B"
        "release:B60205"
        "approval:0E8A16"
        "ready-for-deploy:0E8A16"
        "declined:B60205"
        "risk:B60205"
      )
      for entry in "${LABELS[@]}"; do
        name="${entry%%:*}"
        color="${entry##*:}"
        err=$(cd "$TARGET_ABS" && gh label create "$name" --color "$color" 2>&1)
        if [ $? -eq 0 ]; then
          echo "  Created label: $name"
          LABELS_CREATED=$((LABELS_CREATED + 1))
        elif echo "$err" | grep -qi "already exists"; then
          echo "  Skipped (exists): $name"
        else
          echo "  Failed to create label '$name': $err"
        fi
      done
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
    echo "To update: use --overwrite (run with --dry-run first to preview)."
  fi
fi
echo ""
echo "=== Installation complete ==="
