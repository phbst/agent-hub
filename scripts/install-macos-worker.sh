#!/bin/sh
set -eu
umask 077

[ "$(uname -s)" = "Darwin" ] || { echo "This installer requires macOS." >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "Run as the desktop user, not root." >&2; exit 1; }

CONFIG=${1:-$HOME/.config/agent-hub/worker.toml}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
NODE=$(command -v node)
APP="$HOME/.local/share/agent-hub"
RELEASE="$APP/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/AgentHub"
PLIST="$LAUNCH_AGENTS/com.agent-hub.worker.plist"
EXEC_PATH="$(dirname "$NODE"):$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$ROOT"
npm ci
npm run check
npm run build
install -d -m 700 "$RELEASE" "$LAUNCH_AGENTS" "$LOG_DIR"
cp -R dist/node node_modules package.json "$RELEASE/"
ln -sfn "$RELEASE" "$APP/current"

escape_sed() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
sed \
  -e "s|@NODE_BIN@|$(escape_sed "$NODE")|g" \
  -e "s|@WORKER_MAIN@|$(escape_sed "$APP/current/node/worker-cli/src/main.js")|g" \
  -e "s|@CONFIG_PATH@|$(escape_sed "$CONFIG")|g" \
  -e "s|@HOME_DIR@|$(escape_sed "$HOME")|g" \
  -e "s|@EXEC_PATH@|$(escape_sed "$EXEC_PATH")|g" \
  -e "s|@LOG_DIR@|$(escape_sed "$LOG_DIR")|g" \
  worker-cli/deploy/com.agent-hub.worker.plist.in > "$PLIST.new"
plutil -lint "$PLIST.new" >/dev/null
chmod 600 "$PLIST.new"
mv "$PLIST.new" "$PLIST"

echo "Installed Agent Hub worker release: $RELEASE"
echo "LaunchAgent written to: $PLIST"
echo "Load it after registration credentials exist."
