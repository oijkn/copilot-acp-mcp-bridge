# Test matrix

Documents what is covered by the test suite, what requires a live Copilot instance, and what is explicitly out of scope.

## Environment

| Component | Tested with |
|---|---|
| Node.js | 22.x |
| Copilot CLI | 1.0.9 |
| OS | Ubuntu 24 (WSL2) |
| MCP protocol | 2024-11-05 |
| ACP protocol | 1 |

## Unit tests (no Copilot required)

Run with: `bash test-bridge.sh unit`

| Test | What it verifies |
|---|---|
| `initialize` response | protocolVersion, serverInfo name and version |
| `tools/list` | presence of ask_copilot, copilot_session_status, copilot_reset_session |
| Schema fields | freshSession, context, allowTools, model present; additionalProperties false |
| `copilot_session_status` cold | started=false, sessionId=null, promptCount=0, sessionAgeMs=null, persistentConfiguredModel/modelSource present |
| `ping` | returns `{}` |
| Unknown argument → -32602 | exact error message lists allowed arguments |
| Multiple unknown arguments → -32602 | both flagged in one error |
| Missing prompt → -32602 | correct message |
| Empty prompt → -32602 | whitespace-only prompt rejected |
| Unknown tool → -32601 | |
| Unknown method → -32601 | |
| allowTools enforcement | placeholder only; enforced behavior is validated in live section |
| freshSessions map | placeholder only; cancellation routing is validated in live section |
| `model` invalid value | empty or whitespace-only model is rejected with `-32602` |
| Persistent model conflict | requesting a different model after persistent model selection is rejected with `-32602` |

## Live tests (requires authenticated Copilot CLI)

Run with: `bash test-bridge.sh live`

| Test | What it verifies |
|---|---|
| Persistent session basic call | response received, stopReason present, sessionId present |
| freshSession:true basic call | response received, stopReason present |
| context injection | Copilot uses the injected context in its answer |
| allowTools:false hard block | prompt that would trigger a tool returns no tool_calls in output |
| freshSession + notifications/cancelled | bridge responds to the request after cancellation (no crash, no hang) |
| copilot_reset_session | confirmation returned, started=false after reset |
| Session isolation (freshSession) | secret told in session A is not present in independent session B |

## Not covered by automated tests

| Scenario | Reason |
|---|---|
| ACP `auth_required` handling | Requires an unauthenticated Copilot instance |
| `COPILOT_ACP_MCP_SERVERS_JSON` injection | Requires a running MCP server to inject |
| Concurrent fresh sessions | Race condition testing requires timing control |
| Prompt timeout firing | Still not automated; requires a Copilot instance that can be forced to hang long enough to observe timeout -> session/cancel -> MCP error |
| ACP protocol version mismatch | No mock ACP server available |
| `EAGER_START=1` | Start behavior is observable in logs but not in stdout assertions |
| `PERMISSION_POLICY=cancel` | Requires Copilot to actually request a permission during a test prompt |
| `PREFERRED_PERMISSION_OPTION_ID` | Same constraint as above |
| Effective backend model detection | Copilot ACP does not currently document a machine-readable effective model field |
| `freshSession:true` + `model` live path | Not yet covered end-to-end against a real Copilot instance |
| Persistent model conflict with a live running session | Needs a real persistent session started with model A, then a second persistent request with model B |

## How to add a live test

Add a block in `test-bridge.sh` inside the `else` branch (after the Copilot availability check). Use the `run_bridge` helper for simple single-call tests, or the heredoc pattern for multi-message sequences:

```bash
OUT=$(COPILOT_ACP_BRIDGE_CWD="$CWD" timeout 60 node "$BRIDGE" << MCPEOF 2>/dev/null
$INIT
{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"ask_copilot","arguments":{"prompt":"your prompt here","freshSession":true}}}
MCPEOF
)
assert_contains "my test label" 'expected string' "$OUT"
```
