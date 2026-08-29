#!/bin/sh
set -eu
umask 077

[ "$(id -u)" -ne 0 ] || { echo "Run as the dedicated worker user, not root." >&2; exit 1; }
CONFIG=${1:-$HOME/.config/agent-hub/worker.toml}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
NODE=$(command -v node)
APP="$HOME/.local/share/agent-hub"
RELEASE="$APP/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
SYSTEMD="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

cd "$ROOT"
npm ci
npm run check
npm run build
install -d -m 700 "$RELEASE" "$SYSTEMD"
cp -R dist/node node_modules package.json "$RELEASE/"
ln -sfn "$RELEASE" "$APP/current"

escape() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
sed \
  -e "s|@NODE_BIN@|$(escape "$NODE")|g" \
  -e "s|@WORKER_MAIN@|$(escape "$APP/current/node/worker-cli/src/main.js")|g" \
  -e "s|@CONFIG_PATH@|$(escape "$CONFIG")|g" \
  worker-cli/deploy/agent-hub-worker.service.in > "$SYSTEMD/agent-hub-worker.service.new"
chmod 600 "$SYSTEMD/agent-hub-worker.service.new"
mv "$SYSTEMD/agent-hub-worker.service.new" "$SYSTEMD/agent-hub-worker.service"
systemctl --user daemon-reload
echo "Installed Agent Hub worker release: $RELEASE"
echo "The service remains disabled until registration credentials exist."
