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