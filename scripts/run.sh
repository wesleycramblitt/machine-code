#!/usr/bin/env bash
# Start the machine_code TUI from the built CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node dist/cli.js
