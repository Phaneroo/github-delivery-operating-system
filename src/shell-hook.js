const fs = require('fs');
const os = require('os');
const path = require('path');
const { TEMPLATES } = require('./install');

// `delivery-os shell-hook`: a zsh/bash snippet that prints a one-line reminder
// when you cd into a repo whose Delivery OS install is behind the latest
// release (#90) — the terminal counterpart of the Claude Code SessionStart
// hook in .claude/hooks/delivery-os-update-check.js. It can only remind; the
// update itself is always left to you.
//
// Kept instant: no network call in the foreground. The latest version comes
// from the same day-long cache file the Claude hook uses, refreshed in the
// background with curl when it's missing or stale, so the very first cd after
// a refresh is what shows a newly published version.

const BEGIN_MARKER = '# >>> github-delivery-os update check >>>';
const END_MARKER = '# <<< github-delivery-os update check <<<';
const SHELLS = ['zsh', 'bash'];

function buildSnippet(shell) {
  if (!SHELLS.includes(shell)) throw new Error(`Unsupported shell: ${shell} (use zsh or bash)`);
  const register =
    shell === 'zsh'
      ? [
          '  autoload -Uz add-zsh-hook',
          '  add-zsh-hook chpwd __delivery_os_check',
          '  __delivery_os_check',
        ]
      : [
          '  __delivery_os_prompt() {',
          '    [ "$PWD" = "$__delivery_os_pwd" ] && return 0',
          '    __delivery_os_pwd=$PWD',
          '    __delivery_os_check',
          '  }',
          '  PROMPT_COMMAND="__delivery_os_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
        ];
  return [
    BEGIN_MARKER,
    '# Reminds you when a repo\'s GitHub Delivery OS install is out of date.',
    '# Managed by `npx github-delivery-os shell-hook --install` / `--uninstall`.',
    '__delivery_os_older() {',
    '  awk -v a="$1" -v b="$2" \'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 < y[i] + 0) exit 0; if (x[i] + 0 > y[i] + 0) exit 1 } exit 1 }\'',
    '}',
    '__delivery_os_refresh() {',
    '  local v',
    '  mkdir -p "${1%/*}" || return 0',
    '  v=$(curl -fsS --max-time 5 https://registry.npmjs.org/github-delivery-os/latest 2>/dev/null | grep -o \'"version":"[^"]*"\' | head -n 1 | cut -d\'"\' -f4)',
    '  case "$v" in [0-9]*.[0-9]*.[0-9]*) printf \'%s\\n\' "$v" > "$1.tmp.$$" && mv "$1.tmp.$$" "$1" ;; esac',
    '}',
    '__delivery_os_check() {',
    '  local top manifest installed cache latest flags t',
    '  top=$(git rev-parse --show-toplevel 2>/dev/null) || { __delivery_os_last=; return 0; }',
    '  [ "$top" = "$__delivery_os_last" ] && return 0',
    '  __delivery_os_last=$top',
    '  manifest="$top/.github/delivery-os.json"',
    '  [ -r "$manifest" ] || return 0',
    '  installed=$(grep -o \'"version"[[:space:]]*:[[:space:]]*"[^"]*"\' "$manifest" 2>/dev/null | head -n 1 | sed \'s/.*"\\([^"]*\\)"$/\\1/\')',
    '  [ -n "$installed" ] || return 0',
    '  cache="${XDG_CACHE_HOME:-$HOME/.cache}/github-delivery-os/latest-version"',
    '  if [ ! -s "$cache" ] || [ -n "$(find "$cache" -mmin +1440 2>/dev/null)" ]; then',
    '    ( __delivery_os_refresh "$cache" & ) >/dev/null 2>&1',
    '  fi',
    '  [ -s "$cache" ] || return 0',
    '  latest=$(head -n 1 "$cache")',
    '  __delivery_os_older "$installed" "$latest" || return 0',
    '  flags=',
    `  for t in ${TEMPLATES.join(' ')}; do`,
    '    [ -f "$top/.github/ISSUE_TEMPLATE/$t" ] && { flags="--with-templates "; break; }',
    '  done',
    '  [ -f "$top/.claude/skills/delivery-ops/SKILL.md" ] && flags="${flags}--with-skill "',
    '  printf \'Delivery OS %s installed, %s available. To update, run in %s:\\n  npx github-delivery-os@latest install %s--with-labels --update .\\n\' "$installed" "$latest" "$top" "$flags"',
    '}',
    'case $- in *i*)',
    ...register,
    ';; esac',
    END_MARKER,
  ].join('\n');
}

function detectShell(env = process.env) {
  const name = path.basename(env.SHELL || '');
  return SHELLS.includes(name) ? name : null;
}

function rcFile(shell, env = process.env) {
  if (shell === 'zsh') return path.join(env.ZDOTDIR || os.homedir(), '.zshrc');
  return path.join(os.homedir(), '.bashrc');
}

// Everything in `content` outside our marked block (or the whole thing if
// there's none), so install can replace the block in place and uninstall can
// drop it without touching anything else.
function stripSnippet(content) {
  const start = content.indexOf(BEGIN_MARKER);
  if (start === -1) return { content, found: false };
  const endIdx = content.indexOf(END_MARKER, start);
  if (endIdx === -1) return { content, found: false }; // half a block: leave it for a human
  let end = endIdx + END_MARKER.length;
  if (content[end] === '\n') end++;
  return { content: content.slice(0, start) + content.slice(end), found: true };
}

function installSnippet(file, shell) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { content, found } = stripSnippet(existing);
  const base = content === '' || content.endsWith('\n') ? content : `${content}\n`;
  const separator = base === '' || base.endsWith('\n\n') ? '' : '\n';
  fs.writeFileSync(file, `${base}${separator}${buildSnippet(shell)}\n`);
  return found ? 'updated' : 'added';
}

function uninstallSnippet(file) {
  if (!fs.existsSync(file)) return false;
  const { content, found } = stripSnippet(fs.readFileSync(file, 'utf8'));
  if (found) fs.writeFileSync(file, content.replace(/\n\n+$/, '\n'));
  return found;
}

function runShellHook({ shell, install = false, uninstall = false }) {
  const resolved = shell || detectShell();
  if (!resolved) {
    throw new Error('Could not tell which shell you use from $SHELL — pass one: shell-hook zsh | shell-hook bash');
  }
  if (!install && !uninstall) {
    process.stdout.write(`${buildSnippet(resolved)}\n`);
    return;
  }
  const file = rcFile(resolved);
  if (uninstall) {
    console.log(
      uninstallSnippet(file)
        ? `Removed the Delivery OS update check from ${file}. Open a new terminal for it to take effect.`
        : `No Delivery OS update check found in ${file}.`
    );
    return;
  }
  const result = installSnippet(file, resolved);
  console.log(`${result === 'added' ? 'Added' : 'Updated'} the Delivery OS update check in ${file}.`);
  console.log('Open a new terminal (or source that file). From then on, cd-ing into a repo whose');
  console.log('Delivery OS install is out of date prints a one-line reminder with the update command.');
}

module.exports = {
  runShellHook,
  __test__: { buildSnippet, detectShell, rcFile, stripSnippet, installSnippet, uninstallSnippet, BEGIN_MARKER, END_MARKER },
};
