#!/usr/bin/env bash
# Long-running dev server for the "dev" terminal. Serves the app on :3000.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=.cursor/use-node.sh
source .cursor/use-node.sh

exec pnpm dev
