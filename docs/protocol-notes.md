# Protocol notes

Reference notes on MCP and ACP as they apply to this bridge. Useful when debugging unexpected behavior or evaluating upstream changes.

## MCP (Model Context Protocol)

- Version targeted: `2024-11-05`
- Transport: JSON-RPC 2.0 NDJSON over stdio
- The bridge acts as an **MCP server**
- Relevant methods handled: `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/initialized`, `notifications/cancelled`
- `notifications/cancelled` routes to both the persistent session and any active fresh sessions via the `freshSessions` map
- Prompt timeouts also trigger ACP `session/cancel`, but the MCP side still gets a timeout error rather than a synthetic cancelled payload
- `notifications/progress` is emitted during prompt execution when the client provides a `progressToken` in `_meta`
- Unknown methods return `-32601`. Unknown `ask_copilot` arguments return `-32602` with the list of allowed arguments.

## ACP (Agent Client Protocol)

- Version targeted: `1` (integer, not semver)
- Transport: JSON-RPC 2.0 NDJSON over stdio
- The bridge acts as an **ACP client**
- Copilot CLI acts as an **ACP server** (`copilot --acp --stdio` or `copilot --acp --port <n>`)

### Handshake sequence

```
bridge → copilot : initialize
copilot → bridge : initialize result (agentCapabilities, authMethods)
bridge → copilot : session/new (cwd, mcpServers)
copilot → bridge : session/new result (sessionId)
```

If `session/new` returns `auth_required`, or an ACP error code such as `-32000`/`-32001` indicates auth is required, the bridge can attempt `authenticate` if `AUTO_AUTH_METHOD_ID` is set.

### Prompt sequence

```
bridge → copilot : session/prompt (sessionId, prompt[])
copilot → bridge : session/update* (agent_message_chunk | tool_call | tool_call_update | plan | usage_update)
copilot → bridge : session/prompt result (stopReason)
```

During a prompt, Copilot may also send `session/request_permission`. The bridge responds with:

- `{ outcome: { outcome: 'selected', optionId } }` when a matching option is found and `allowTools !== false`
- `{ outcome: { outcome: 'cancelled' } }` when `allowTools === false`, when no option matches, or when `permissionPolicy` is `cancel`

The `allowTools: false` check runs before `permissionPolicy`, making it a hard block regardless of other configuration.

### Cancellation

The bridge sends `session/cancel` to Copilot when:
- MCP `notifications/cancelled` is received for an active request
- A prompt timeout fires
- The bridge shuts down with active sessions

### session/update types captured

| Type | Captured | Included in MCP response |
|---|---|---|
| `agent_message_chunk` | yes | yes (as final text) |
| `tool_call` | yes | yes (telemetry block) |
| `tool_call_update` | yes | yes (telemetry block) |
| `plan` | yes | yes (telemetry block) |
| `usage_update` | yes | yes if `INCLUDE_USAGE_IN_OUTPUT=true` |
| others | yes (counted) | `other_updates: N` in telemetry |

## Permission policy

Controlled by `PERMISSION_POLICY` environment variable:

| Value | Behavior |
|---|---|
| `first` | Auto-select the first option offered (default) |
| `prefer-allow` | Try to find an option with `allow` or `approve` in name/kind before falling back to first |
| `cancel` | Always cancel, never approve any permission |

`PREFERRED_PERMISSION_OPTION_ID` takes priority over `permissionPolicy` when set and matches an offered option.

`allowTools: false` on a prompt overrides all of the above and always cancels.

## Known ACP surface limitations

- `cwd` is fixed per `session/new`. There is no per-prompt working directory.
- `session/load` (resume a previous session) is not implemented.
- `session/fork`, `session/list`, `session/close` are not implemented.
- Client capabilities (`fs/*`, `terminal/*`) are declared empty. Copilot may not use them.
- ACP is in public preview. The protocol version may increment with breaking changes.
