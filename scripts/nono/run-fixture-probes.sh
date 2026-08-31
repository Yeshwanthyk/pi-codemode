#!/bin/bash
# Runs inside one outer nono session. PATH is shim-prefixed by Tool Sandbox, so
# these bare command names are independently delegated by the broker.
set -euo pipefail

cd /tmp/nono-per-server-proof

mcp-alpha --nono-proof
mcp-beta --nono-proof
mcp-alpha --nono-proof-output > /tmp/nono-per-server-proof/alpha-bounded.stdout

test "$(wc -c < /tmp/nono-per-server-proof/alpha-bounded.stdout)" -eq 16384
printf 'PASS brokered stdio truncated alpha stdout at 16384 bytes\n'
