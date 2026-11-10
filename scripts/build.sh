#!/usr/bin/env bash
# Build the TypeScript CLI and keep dist/cli.js executable.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
