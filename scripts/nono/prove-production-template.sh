#!/bin/bash
# Offline proof for the production-oriented template. It validates the exact
# Sentry argv shape without contacting npm or Sentry.
set -euo pipefail

readonly ROOT="/Users/yesh/.pi/pi-codemode"
readonly NONO="/opt/homebrew/bin/nono"
readonly PROFILE="$ROOT/nono/per-server.profile.json"
readonly OUT="/tmp/nono-production-policy-proof"

mkdir -p "$OUT"
"$NONO" profile validate --strict "$PROFILE"

# On macOS, a Tool Sandbox child must be able to resolve every ancestor of its
# cwd. Use a neutral cwd rather than broadening this child to $HOME/.pi, which
# would undermine the profile's production posture.
cd /tmp

"$NONO" run --dry-run --profile "$PROFILE" -- \
  npx -y mcp-remote@latest https://mcp.sentry.dev/mcp \
  >"$OUT/exact-argv.stdout" 2>"$OUT/exact-argv.stderr"
grep -q 'npx -y mcp-remote@latest https://mcp.sentry.dev/mcp' "$OUT/exact-argv.stderr"
printf 'PASS exact repository Sentry npx argv resolves in dry-run\n'

if "$NONO" run --profile "$PROFILE" -- npx --version \
    >"$OUT/wrong-argv.stdout" 2>"$OUT/wrong-argv.stderr"; then
  printf 'FAIL non-Sentry npx argv unexpectedly succeeded\n' >&2
  exit 1
fi
grep -q 'invocation_policy.default deny' "$OUT/wrong-argv.stderr"
printf 'PASS all other npx argv denied by invocation policy\n'

if "$NONO" run --profile "$PROFILE" -- \
    /Users/yesh/.nvm/versions/node/v22.22.2/lib/node_modules/npm/bin/npx-cli.js --version \
    >"$OUT/bypass.stdout" 2>"$OUT/bypass.stderr"; then
  printf 'FAIL direct npx absolute-path bypass unexpectedly succeeded\n' >&2
  exit 1
fi
grep -q 'direct exec bypass denied' "$OUT/bypass.stderr"
printf 'PASS direct npx absolute-path bypass denied\n'

printf 'NOTE GitHub HTTP MCP has no executable child; the profile can only route-limit it at https://api.githubcopilot.com/mcp/** in the outer network policy.\n'
