#!/bin/bash
# Validate the two profiles, prove their static contract, then (when the external
# test fixtures exist) exercise OS-enforced child sandboxes and broker audit data.
set -euo pipefail

readonly ROOT="/Users/yesh/.pi/pi-codemode"
readonly NONO="/opt/homebrew/bin/nono"
readonly PROD="$ROOT/nono/per-server.profile.json"
readonly FIXTURES="$ROOT/nono/per-server-fixtures.profile.json"
readonly PROOF_DIR="/tmp/nono-per-server-proof"
readonly PROBE_PORT=39873

cd "$ROOT"
mkdir -p "$PROOF_DIR" \
  scripts/nono/proof-data/alpha/output \
  scripts/nono/proof-data/beta/output
rm -rf "$PROOF_DIR"/*

"$NONO" profile validate --strict "$PROD"
"$NONO" profile validate --strict "$FIXTURES"

python3 - "$PROD" "$FIXTURES" <<'PY'
import json
import sys

prod = json.load(open(sys.argv[1], encoding="utf-8"))
fixtures = json.load(open(sys.argv[2], encoding="utf-8"))
commands = fixtures["command_policies"]["commands"]
assert set(commands) == {"mcp-alpha", "mcp-beta"}
assert fixtures["network"]["block"] is True
assert fixtures["network"].get("credentials", []) == []

grants = {}
for name, command in commands.items():
    assert command["allow_writable_executable"] is True
    assert command.get("allow_direct_exec_bypass", []) == []
    sandbox = command["from"]["session"]["sandbox"]
    assert sandbox["network"] == {}
    assert not sandbox.get("use_credentials") and not sandbox.get("credentials")
    assert sandbox["stdio"]["stdout"] == {"max_bytes": 16384, "on_limit": "truncate"}
    assert sandbox["stdio"]["stderr"] == {"max_bytes": 8192, "on_limit": "terminate"}
    grants[name] = (tuple(sandbox["fs_read"]), tuple(sandbox["fs_write"]))
assert grants["mcp-alpha"] != grants["mcp-beta"]
assert set(fixtures["command_policies"]["deny_direct_exec_bypass"]) == {
    commands["mcp-alpha"]["executable"], commands["mcp-beta"]["executable"]
}

npx = prod["command_policies"]["commands"]["npx"]
edge = npx["from"]["session"]
expected = ["-y", "mcp-remote@latest", "https://mcp.sentry.dev/mcp"]
assert edge["invocation_policy"]["default"] == "deny"
assert edge["invocation_policy"]["allow"][0]["argv"]["exact"] == expected
assert npx["intercept"][0]["match"]["argv"]["exact"] == expected
assert prod["network"]["credentials"] == []
assert "https://api.githubcopilot.com/mcp/**" in prod["network"]["allow_domain"]
print("PASS profile contract: distinct fixture grants, zero child credentials/network, bounded stdio, bypass governance, exact Sentry argv, explicit HTTP route")
PY

missing=0
for fixture in test/fixtures/mcp-alpha test/fixtures/mcp-beta; do
  if [[ ! -x "$fixture" ]]; then
    printf 'MISSING executable fixture: %s\n' "$ROOT/$fixture" >&2
    missing=1
  fi
done
if (( missing )); then
  cat >&2 <<'EOF'
RUNTIME PROOF BLOCKED: this checkout does not contain the two externally-owned
fixture executables. Profile/schema validation and static policy proof passed,
but nono cannot resolve a pinned command target that does not exist. Add the
executable fixtures at the exact paths above, then rerun this script. No profile
trust override can safely or honestly turn a missing executable into a runtime proof.
EOF
  exit 2
fi

# Establish a real host listener so the child network-denial checks cannot pass
# merely because a port was closed.
python3 -m http.server "$PROBE_PORT" --bind 127.0.0.1 \
  >"$PROOF_DIR/listener.stdout" 2>"$PROOF_DIR/listener.stderr" &
listener_pid=$!
cleanup() {
  kill "$listener_pid" 2>/dev/null || true
  wait "$listener_pid" 2>/dev/null || true
  rm -f \
    "$ROOT/scripts/nono/proof-data/alpha/output/probe.txt" \
    "$ROOT/scripts/nono/proof-data/beta/output/probe.txt"
}
trap cleanup EXIT
python3 - "$PROBE_PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
for _ in range(50):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=.1):
            print(f"PASS host network control: listener reachable on 127.0.0.1:{port}")
            break
    except OSError:
        time.sleep(.05)
else:
    raise SystemExit("host proof listener did not become reachable")
PY

AWS_SECRET_ACCESS_KEY=nono-must-not-cross \
SENTRY_AUTH_TOKEN=nono-must-not-cross \
MCP_TEST_CREDENTIAL=nono-must-not-cross \
"$NONO" run --profile "$FIXTURES" --allow-cwd --name nono-per-server-proof -- \
  /bin/bash "$ROOT/scripts/nono/run-fixture-probes.sh"

"$NONO" audit list --recent 20 --json > "$PROOF_DIR/audit-list.json"
session_id=$(python3 - "$PROOF_DIR/audit-list.json" <<'PY'
import json, sys
for session in json.load(open(sys.argv[1], encoding="utf-8")):
    command = session.get("command", [])
    if any(str(arg).endswith("scripts/nono/run-fixture-probes.sh") for arg in command):
        print(session["session_id"])
        break
else:
    raise SystemExit("could not find fixture proof audit session")
PY
)
"$NONO" audit show "$session_id" --json > "$PROOF_DIR/audit-show.json"

python3 - "$PROOF_DIR/audit-show.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
events = report.get("command_policy_events", [])
by_command = {}
for event in events:
    by_command.setdefault(event.get("command"), []).append(event)
for name in ("mcp-alpha", "mcp-beta"):
    assert name in by_command, f"missing separate broker audit record for {name}"
alpha_stdio = [e.get("stdio", {}).get("stdout", {}) for e in by_command["mcp-alpha"]]
assert any(s.get("limit_exceeded") and s.get("forwarded_bytes") == 16384 for s in alpha_stdio), alpha_stdio
print("PASS audit: separate mcp-alpha/mcp-beta records and alpha stdout limit_exceeded=true")
PY

for name in mcp-alpha mcp-beta; do
  absolute="$ROOT/test/fixtures/$name"
  if "$NONO" run --profile "$FIXTURES" -- "$absolute" --nono-proof \
      >"$PROOF_DIR/$name-bypass.stdout" 2>"$PROOF_DIR/$name-bypass.stderr"; then
    printf 'FAIL direct absolute-path bypass unexpectedly succeeded: %s\n' "$absolute" >&2
    exit 1
  fi
  grep -qi 'direct exec bypass denied' "$PROOF_DIR/$name-bypass.stderr"
  printf 'PASS direct absolute-path bypass denied: %s\n' "$absolute"
done

NONO_BROKERED_MCP_FIXTURES=1 \
MCP_FIXTURE_MARKER_ROOT="$PROOF_DIR" \
"$NONO" run --silent --profile "$FIXTURES" --allow-cwd -- \
  node node_modules/vitest/vitest.mjs run test/live-mcp-integration.test.ts
printf 'PASS real MCP protocol, CodeMode orchestration, cancellation, crash, and reconnect through brokered child policies\n'

printf 'PASS complete runtime proof; audit session: %s\n' "$session_id"
printf 'Audit JSON: %s/audit-show.json\n' "$PROOF_DIR"
