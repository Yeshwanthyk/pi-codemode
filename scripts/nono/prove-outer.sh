#!/bin/bash
# Validate the outer profile, exercise its filesystem/network/credential boundary,
# then run the real two-server stdio MCP/CodeMode integration inside that sandbox.
set -euo pipefail

readonly ROOT="/Users/yesh/.pi/pi-codemode"
readonly NONO="/opt/homebrew/bin/nono"
readonly PROFILE="$ROOT/nono/pi-codemode.profile.json"

cd "$ROOT"
"$NONO" profile validate --strict "$PROFILE"
node node_modules/vitest/vitest.mjs run test/nono-live.test.ts
"$NONO" run --silent --profile "$PROFILE" --allow-cwd -- \
  node node_modules/vitest/vitest.mjs run test/live-mcp-integration.test.ts
printf 'PASS outer Nono boundary and live CodeMode/MCP traffic\n'
