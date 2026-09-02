#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
exec node "$SCRIPT_DIR/fake-cursor-agent.mjs" "$@"
