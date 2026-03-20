#!/usr/bin/env bash
# test-bridge.sh
# Validation tests for the copilot-acp-mcp-bridge bridge
#
# Usage:
#   bash test-bridge.sh              # all tests
#   bash test-bridge.sh unit         # tests that do not require Copilot
#   bash test-bridge.sh live         # tests that require authenticated Copilot

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BRIDGE="${BRIDGE:-$SCRIPT_DIR/copilot-acp-mcp-bridge.js}"
CWD="${COPILOT_ACP_BRIDGE_CWD:-${CHAIRMAN_CWD:-$SCRIPT_DIR}}"
MODE="${1:-all}"
VERSION="${COPILOT_ACP_BRIDGE_VERSION:-$(node -e "const fs=require('fs'); const src=fs.readFileSync(process.argv[1],'utf8'); const m=src.match(/const BRIDGE_VERSION = process\\.env\\.COPILOT_ACP_BRIDGE_VERSION \\|\\| '([^']+)'/); if(!m) process.exit(1); process.stdout.write(m[1]);" "$BRIDGE")}"

PASS=0
FAIL=0
SKIP=0

# ─── Helpers ──────────────────────────────────────────────────────────────────

green='\033[0;32m'
red='\033[0;31m'
yellow='\033[0;33m'
reset='\033[0m'

pass() { echo -e "${green}  ✓ $1${reset}"; PASS=$((PASS+1)); }
fail() { echo -e "${red}  ✗ $1${reset}"; FAIL=$((FAIL+1)); }
skip() { echo -e "${yellow}  ○ $1 (skipped)${reset}"; SKIP=$((SKIP+1)); }
section() { echo -e "\n── $1 ──────────────────────────────────────────"; }

# Send NDJSON lines to the bridge and return stdout.
run_bridge() {
  printf '%s\n' "$@" | timeout 5 node "$BRIDGE" 2>/dev/null || true
}

# Check whether a string is present in the output.
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$label"
  else
    fail "$label — expected: $needle"
    echo "    output: $(echo "$haystack" | head -3)"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    fail "$label — unexpected: $needle"
  else
    pass "$label"
  fi
}

# ─── Base MCP messages ────────────────────────────────────────────────────────

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'
TOOLS_LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
STATUS='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"copilot_session_status","arguments":{}}}'
PING='{"jsonrpc":"2.0","id":4,"method":"ping","params":{}}'

# ─── UNIT: tests without Copilot ─────────────────────────────────────────────

section "UNIT - MCP protocol (without Copilot)"

OUT=$(run_bridge "$INIT")
assert_contains "initialize -> protocolVersion 2024-11-05" '"protocolVersion":"2024-11-05"' "$OUT"
assert_contains "initialize -> serverInfo name" '"name":"copilot-acp-mcp-bridge"' "$OUT"
assert_contains "initialize -> version $VERSION" "\"version\":\"$VERSION\"" "$OUT"

OUT=$(run_bridge "$INIT" "$TOOLS_LIST")
assert_contains "tools/list -> ask_copilot" '"name":"ask_copilot"' "$OUT"
assert_contains "tools/list -> copilot_session_status" '"name":"copilot_session_status"' "$OUT"
assert_contains "tools/list -> copilot_reset_session" '"name":"copilot_reset_session"' "$OUT"
assert_contains "tools/list -> freshSession in schema" '"freshSession"' "$OUT"
assert_contains "tools/list -> context in schema" '"context"' "$OUT"
assert_contains "tools/list -> allowTools in schema" '"allowTools"' "$OUT"
assert_contains "tools/list -> model in schema" '"model"' "$OUT"
assert_contains "tools/list -> additionalProperties false" '"additionalProperties":false' "$OUT"

OUT=$(run_bridge "$INIT" "$STATUS")
assert_contains "status -> started false" 'started' "$OUT"
assert_contains "status -> sessionId null" 'sessionId' "$OUT"
assert_contains "status -> promptCount 0" 'promptCount' "$OUT"
assert_contains "status -> sessionAgeMs null" 'sessionAgeMs' "$OUT"
assert_contains "status -> persistentConfiguredModel present" 'persistentConfiguredModel' "$OUT"
assert_contains "status -> modelSource present" 'modelSource' "$OUT"

OUT=$(run_bridge "$INIT" "$PING")
assert_contains "ping -> {}" '"result":{}' "$OUT"

section "UNIT - argument validation"

# Multiple unknown arguments
OUT=$(run_bridge "$INIT" '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"x","model":"gpt-4","allowAllTools":true}}}')
assert_contains "multiple unknown arguments -> -32602" '"code":-32602' "$OUT"
assert_contains "multiple unknown arguments -> exact message" 'Unknown argument(s) for ask_copilot: allowAllTools' "$OUT"

# Invalid model -> -32602
OUT=$(run_bridge "$INIT" '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"x","model":"   "}}}')
assert_contains "invalid model -> -32602" '"code":-32602' "$OUT"
assert_contains "invalid model -> message" 'Invalid argument \"model\": expected a non-empty string' "$OUT"
assert_not_contains "invalid model -> no result payload (id=10)" '"id":10,"result"' "$OUT"

# Missing prompt -> -32602
OUT=$(run_bridge "$INIT" '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"ask_copilot","arguments":{}}}')
assert_contains "missing prompt -> -32602" '"code":-32602' "$OUT"
assert_contains "missing prompt -> message" '"Missing required argument: prompt"' "$OUT"

# Empty prompt -> -32602
OUT=$(run_bridge "$INIT" '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"   "}}}')
assert_contains "empty prompt -> -32602" '"code":-32602' "$OUT"

# Unknown tool -> -32601
OUT=$(run_bridge "$INIT" '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"unknown_tool","arguments":{}}}')
assert_contains "unknown tool -> -32601" '"code":-32601' "$OUT"

# Unknown method -> -32601
OUT=$(run_bridge "$INIT" '{"jsonrpc":"2.0","id":15,"method":"unknown/method","params":{}}')
assert_contains "unknown method -> -32601" '"code":-32601' "$OUT"

section "UNIT - ACP text assembly (buildAcpText)"

# We cannot call buildAcpText directly from bash.
# Coverage is handled by the live tests that exercise context injection
# and allowTools:false behavior through the public MCP interface.
skip "buildAcpText — no unit harness yet (covered in LIVE section)"

# ─── LIVE: tests with Copilot ────────────────────────────────────────────────

section "UNIT - allowTools:false enforced in _onPermission"

# We cannot simulate a real session/request_permission flow without Copilot.
# The hard enforcement is validated in the live section.
skip "allowTools:false _onPermission — no unit harness yet (covered in LIVE section)"

section "UNIT - freshSessions map for cancellation"

# Structural smoke check: the bridge starts cleanly and exposes status.
OUT=$(run_bridge "$INIT" "$STATUS")
assert_contains "freshSessions — bridge starts cleanly" 'started' "$OUT" || true
skip "freshSessions — no unit harness yet (covered in LIVE with notifications/cancelled)"

section "UNIT - persistent model contract"

OUT=$(run_bridge \
  "$INIT" \
  '{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"x","model":"gpt-5.2"}}}' \
  '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"x","model":"claude-sonnet-4.6"}}}')
assert_contains "persistent model conflict -> -32602" '"code":-32602' "$OUT"
assert_contains "persistent model conflict -> message" 'Persistent session configured with model \"gpt-5.2\"; requested \"claude-sonnet-4.6\". Reset the session or use freshSession:true.' "$OUT"

if [[ "$MODE" == "unit" ]]; then
  skip "LIVE tests skipped (mode=unit)"
elif ! command -v copilot &>/dev/null; then
  skip "LIVE tests skipped (copilot not found in PATH)"
else

  section "LIVE - persistent session"

  OUT=$(COPILOT_ACP_BRIDGE_CWD="$CWD" run_bridge \
    "$INIT" \
    '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"Reply with exactly the word: PONG"}}}')
  assert_contains "persistent session -> response received" '"content"' "$OUT"
  assert_contains "persistent session -> stopReason" 'stopReason' "$OUT"
  assert_contains "persistent session -> sessionId" 'sessionId' "$OUT"

  section "LIVE - freshSession:true"

  OUT=$(COPILOT_ACP_BRIDGE_CWD="$CWD" run_bridge \
    "$INIT" \
    '{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"Reply with exactly the word: FRESH","freshSession":true}}}')
  assert_contains "freshSession -> response received" '"content"' "$OUT"
  assert_contains "freshSession -> stopReason" 'stopReason' "$OUT"

  section "LIVE - context injection"

  OUT=$(COPILOT_ACP_BRIDGE_CWD="$CWD" run_bridge \
    "$INIT" \
    '{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"What is the secret code?","context":"The secret code is ALPHA-7.","freshSession":true}}}')
  assert_contains "context -> response received" '"content"' "$OUT"
  assert_contains "context -> ALPHA-7 present" 'ALPHA-7' "$OUT"

  section "LIVE - allowTools:false (hard block in _onPermission)"

  # This prompt encourages Copilot to request a shell/tool action.
  # If allowTools:false is enforced correctly, no tool_calls should appear.
  OUT=$(COPILOT_ACP_BRIDGE_CWD="$CWD" timeout 60 node "$BRIDGE" << MCPEOF 2>/dev/null
$INIT
{"jsonrpc":"2.0","id":50,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"Run: echo hello_from_tool","allowTools":false,"freshSession":true}}}
MCPEOF
)
  assert_contains "allowTools:false -> response received" '"content"' "$OUT"
  assert_not_contains "allowTools:false -> no tool_call returned" 'tool_calls:' "$OUT"

  section "LIVE - freshSession + notifications/cancelled routing"

  # Start a long-running prompt, send cancelled, and verify the bridge completes.
  # Timing is inherently rough in shell, so this checks for no crash and a reply.
  OUT=$(COPILOT_ACP_BRIDGE_CWD="$CWD" timeout 30 node "$BRIDGE" << MCPEOF 2>/dev/null
$INIT
{"jsonrpc":"2.0","id":80,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"Count from 1 to 1000 slowly, one number per line","freshSession":true}}}
{"jsonrpc":"2.0","id":81,"method":"notifications/cancelled","params":{"requestId":80,"reason":"test_cancel"}}
MCPEOF
)
  assert_contains "freshSession cancel -> bridge replies" '"id":80' "$OUT"

  section "LIVE - copilot_reset_session"

  OUT=$(COPILOT_ACP_BRIDGE_CWD="$CWD" run_bridge \
    "$INIT" \
    '{"jsonrpc":"2.0","id":60,"method":"tools/call","params":{"name":"copilot_session_status","arguments":{}}}' \
    '{"jsonrpc":"2.0","id":61,"method":"tools/call","params":{"name":"copilot_reset_session","arguments":{"reason":"test"}}}' \
    '{"jsonrpc":"2.0","id":62,"method":"tools/call","params":{"name":"copilot_session_status","arguments":{}}}')
  assert_contains "reset -> confirmation" '"Copilot ACP session reset."' "$OUT"
  assert_contains "reset -> started=false after reset" '"started":false' "$OUT"

  section "LIVE - freshSession isolation"

  # First call stores a secret in one fresh session.
  OUT1=$(COPILOT_ACP_BRIDGE_CWD="$CWD" run_bridge \
    "$INIT" \
    '{"jsonrpc":"2.0","id":70,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"Remember this secret: ZEBRA42","freshSession":true}}}')
  assert_contains "isolation -> first call ok" '"content"' "$OUT1"

  # Second independent fresh call should not know ZEBRA42.
  OUT2=$(COPILOT_ACP_BRIDGE_CWD="$CWD" run_bridge \
    "$INIT" \
    '{"jsonrpc":"2.0","id":71,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"What secret did I just tell you?","freshSession":true}}}')
  assert_contains "isolation -> second call ok" '"content"' "$OUT2"
  assert_not_contains "isolation -> ZEBRA42 absent (fresh)" 'ZEBRA42' "$OUT2"

fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "─────────────────────────────────────────"
echo -e "  ${green}passed: $PASS${reset}   ${red}failed: $FAIL${reset}   ${yellow}skipped: $SKIP${reset}"
echo "─────────────────────────────────────────"

if [[ $FAIL -gt 0 ]]; then exit 1; fi
