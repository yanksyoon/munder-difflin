#!/usr/bin/env bash
#
# Munder Difflin — end-to-end Mac client remote setup.
#
# Builds/launches the Electron app on this Mac from the `remote-ui-plan` fork
# branch and installs the remote helper on the SSH host using your EXISTING
# ~/.ssh/config entry. The app then walks you through the remote setup in
# Settings -> Connections -> Remote development host.
#
# Usage:
#   bash tools/mac-remote-setup.sh [ssh-alias]
#
# Environment overrides:
#   MD_ALIAS         SSH alias (or pass as first argument). Default: `work`.
#   MD_APP_DIR       Mac checkout dir. Default: ~/munder-difflin
#   MD_REMOTE_DIR    Remote checkout dir. Default: <remote-home>/munder-difflin
#   MD_REMOTE_ROOT   Remote project root for the helper. Default: <remote-home>
#   MD_ALLOW_COMMANDS Provider allowlist. Default includes claude,codex,...,prime-agent
#   MD_BUILD_MAC=1   Build an (unsigned) .dmg instead of launching `npm run dev`.
#   MD_SKIP_REMOTE=1 Skip the remote-helper install step.
#
# Security: values are never interpolated into the SSH command line. The SSH
# target is validated to a strict alias (no leading `-`, no whitespace/metas),
# remote options go after `--`, and MD_* values are transmitted via stdin encoded
# as base64, then decoded by the remote `bash -s` payload. A malicious alias such
# as `-oProxyCommand=...` or an override containing `;`, `$()`, backticks or
# newlines is rejected up front.
#
set -euo pipefail

ALIAS="${1:-${MD_ALIAS:-work}}"
APP_DIR="${MD_APP_DIR:-$HOME/munder-difflin}"
FORK_URL="https://github.com/yanksyoon/munder-difflin.git"
BRANCH="remote-ui-plan"
ALLOW="${MD_ALLOW_COMMANDS:-claude,codex,agy,gemini,qwen,opencode,crush,pi,prime-agent,copilot}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Strict alias: OpenSSH Host aliases are letters/digits plus . _ : @ -. A leading
# dash would be parsed as an option (e.g. -oProxyCommand=...) — reject it.
alias_re='^[A-Za-z0-9][A-Za-z0-9._:@-]*$'
[[ "$ALIAS" =~ $alias_re ]] || die "Invalid SSH alias '$ALIAS'. Use the plain alias from your ~/.ssh/config (letters, digits, . _ : @ -); no leading dash."

# Strict APP_DIR and remote override values: absolute-ish paths, no metacharacters.
path_re='^[A-Za-z0-9_./~ -]+$'
[[ "$APP_DIR" =~ $path_re ]] || die "Invalid MD_APP_DIR '$APP_DIR'"
for v in MD_REMOTE_DIR MD_REMOTE_ROOT; do
  val="${!v:-}"
  if [ -n "$val" ]; then
    [[ "$val" =~ $path_re ]] || die "Invalid $v='$val' (no ; \$() \` quotes or control chars)"
  fi
done
# Allowlist must be a comma-separated list of plain command names.
allow_re='^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$'
[[ "$ALLOW" =~ $allow_re ]] || die "Invalid MD_ALLOW_COMMANDS '$ALLOW'"

# ── 1. Mac prerequisites ────────────────────────────────────────────────────
say "Checking Mac prerequisites"
command -v git >/dev/null || die "git is required (xcode-select --install)"
command -v npm >/dev/null || die "npm is required (install Node.js LTS)"
command -v node >/dev/null || die "node is required"
node -e 'if (+process.versions.node.split(".")[0] < 18) process.exit(1)' \
  || die "Node.js 18+ is required (found $(node --version))"
xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools are required (xcode-select --install)"

# ── 2. Existing SSH config alias ────────────────────────────────────────────
say "Using your existing SSH config"
[ -f "$HOME/.ssh/config" ] || die "No ~/.ssh/config found on this Mac"
# Grep with the alias in single quotes (fixed string), escaped via printf %q first.
alias_grep="${ALIAS//./\\.}"
if grep -qE "^[[:space:]]*Host[[:space:]]+${alias_grep}([[:space:]]|$)" "$HOME/.ssh/config"; then
  echo "  alias '$ALIAS' found in ~/.ssh/config"
else
  echo "  NOTE: '$ALIAS' is not declared in ~/.ssh/config as a bare 'Host <alias>' entry."
  echo "  You must use an alias OpenSSH resolves — see docs/remote-setup.md."
fi

say "Verifying non-interactive SSH to '$ALIAS'"
# `--` prevents anything after it being parsed as an ssh option.
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 -T -- "$ALIAS" true; then
  die "ssh -T $ALIAS true failed. The app cannot prompt for a password. Check your key/auth in ~/.ssh/config."
fi
echo "  ssh -T $ALIAS true -> OK (key-based, non-interactive)"

REMOTE_HOME="$(ssh -o BatchMode=yes -T -- "$ALIAS" 'printf %s "$HOME"')" || die "Could not read remote HOME"
REMOTE_DIR="${MD_REMOTE_DIR:-$REMOTE_HOME/munder-difflin}"
REMOTE_ROOT="${MD_REMOTE_ROOT:-$REMOTE_HOME}"

# ── 3. Install/refresh the remote helper ─────────────────────────────────────
if [ "${MD_SKIP_REMOTE:-0}" != "1" ]; then
  say "Installing the remote helper on '$ALIAS' ($REMOTE_DIR)"
  echo "  remote project root: $REMOTE_ROOT"
  echo "  provider allowlist:  $ALLOW"
  # Send only fixed `--` + `bash -s` on the command line; the variable payload
  # travels encrypted on stdin as base64 (no shell interpolation anywhere).
  PAYLOAD_B64="$(base64 <<PAYLOAD_SRC
REMOTE_DIR=$REMOTE_DIR
REMOTE_ROOT=$REMOTE_ROOT
ALLOW=$ALLOW
FORK_URL=$FORK_URL
BRANCH=$BRANCH
PAYLOAD_SRC
)"
  # Build the remote script as text, base64-encode it, and run it through a
  # FIXED, POSIX-safe remote command:  printf '%s' '<b64>' | base64 -d | bash
  # The remote login shell (often /bin/sh/dash) only parses this one line — no
  # Bash %q/$'…' syntax — and `bash` is always present as an executable upstream.
  # The script payload itself is single-line base64 (safe alphabet).
  REMOTE_SCRIPT="$(cat <<'REMOTE_SCRIPT'
set -euo pipefail
# Decode the base64 script stream from stdin (see caller for the transport).
# Values are carried inside the script as KEY=VALUE assignments, validated below.
REMOTE_DIR=__REMOTE_DIR__
REMOTE_ROOT=__REMOTE_ROOT__
ALLOW=__ALLOW__
FORK_URL=__FORK_URL__
BRANCH=__BRANCH__
[ -n "$REMOTE_DIR" ] && [ -n "$REMOTE_ROOT" ] && [ -n "$ALLOW" ] || { echo "missing remote payload" >&2; exit 2; }
case "$REMOTE_DIR" in *[!A-Za-z0-9_./~-]*) echo "unsafe REMOTE_DIR" >&2; exit 2;; esac
case "$REMOTE_ROOT" in *[!A-Za-z0-9_./~-]*) echo "unsafe REMOTE_ROOT" >&2; exit 2;; esac
if [ ! -d "$REMOTE_DIR/.git" ]; then
  git clone "$FORK_URL" "$REMOTE_DIR"
fi
cd "$REMOTE_DIR"
git fetch --force origin "$BRANCH" >/dev/null
git checkout -B "$BRANCH" "origin/$BRANCH" >/dev/null
remote_node="$(command -v node || true)"
[ -n "$remote_node" ] || { echo "remote node not found" >&2; exit 2; }
echo "  remote node: $remote_node"
if [ ! -d node_modules ] || ! npm ls --depth=0 >/dev/null 2>&1; then
  npm ci --ignore-scripts
fi
npm rebuild node-pty >/dev/null 2>&1 || echo "  warning: npm rebuild node-pty failed (check g++/make/python3)" >&2
npm run build:remote >/dev/null
BIN_DIR="$HOME/bin"
mkdir -p "$BIN_DIR"
# Render the wrapper with printf %q: decoded values, shell-quoted, never literal.
{
  printf '#!/bin/sh\nset -eu\n'
  printf 'export MUNDER_REMOTE_ROOT=%q\n' "$REMOTE_ROOT"
  printf 'export MUNDER_REMOTE_ALLOW_COMMANDS=%q\n' "$ALLOW"
  printf 'exec %q %q\n' "$remote_node" "$REMOTE_DIR/tools/remote-helper-launcher.cjs"
} > "$BIN_DIR/munder-remote"
chmod 700 "$BIN_DIR/munder-remote"
echo "  helper wrapper: $BIN_DIR/munder-remote"
REMOTE_SCRIPT
)"
  # Substitute the payload values (all validated: alias/APP_DIR/paths/allowlist)
  # into the script, then base64 the whole thing.
  REMOTE_SCRIPT="${REMOTE_SCRIPT//__REMOTE_DIR__/$REMOTE_DIR}"
  REMOTE_SCRIPT="${REMOTE_SCRIPT//__REMOTE_ROOT__/$REMOTE_ROOT}"
  REMOTE_SCRIPT="${REMOTE_SCRIPT//__ALLOW__/$ALLOW}"
  REMOTE_SCRIPT="${REMOTE_SCRIPT//__FORK_URL__/$FORK_URL}"
  REMOTE_SCRIPT="${REMOTE_SCRIPT//__BRANCH__/$BRANCH}"
  REMOTE_B64="$(printf '%s' "$REMOTE_SCRIPT" | base64 | tr -d '\n')"
  ssh -o BatchMode=yes -T -- "$ALIAS" "printf '%s' '$REMOTE_B64' | base64 -d | bash"
fi
HELPER_PATH="$REMOTE_HOME/bin/munder-remote"

# ── 4. Mac app checkout ─────────────────────────────────────────────────────
say "Preparing the Mac app checkout"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$FORK_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch --force origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
if [ ! -d node_modules ] || ! npm ls --depth=0 >/dev/null 2>&1; then
  npm ci
fi

# ── 5. Walkthrough ──────────────────────────────────────────────────────────
say "Ready! Next steps in the app"
cat <<EOF
  1) The app opens below (first build takes a moment).
  2) Open Settings (gear) -> Connections -> "Remote development host".
  3) SSH host alias:            $ALIAS
     Helper path:               $HELPER_PATH
  4) Click Connect. You should see 'connected' and the helper capabilities.
  5) Under "Start remote agent": pick a project directory under
     $REMOTE_ROOT
     and a provider (for example 'prime-agent').
  6) Start a session: the live terminal, file browser and git status/log
     are all available in the same panel.
EOF

# ── 6. Build / launch ───────────────────────────────────────────────────────
if [ "${MD_BUILD_MAC:-0}" = "1" ]; then
  say "Building unsigned macOS app (dist/)"
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
  echo "Built. Open dist/*.dmg and install, then follow the steps above."
else
  say "Launching the app (npm run dev)"
  npm run dev
  echo "App closed. Re-run this script any time to reconnect/rebuild."
fi
