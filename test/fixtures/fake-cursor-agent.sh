#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
NODE_BIN="$SCRIPT_DIR/node"
if "$NODE_BIN" --use-system-ca --version >/dev/null 2>&1; then
  exec -a "$0" "$NODE_BIN" --use-system-ca "$SCRIPT_DIR/index.js" "$@"
fi
exec -a "$0" "$NODE_BIN" "$SCRIPT_DIR/index.js" "$@"
