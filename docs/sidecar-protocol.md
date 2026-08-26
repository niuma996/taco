# Taco Sidecar Protocol

> **版本**: 0.1.0
> **传输**: NDJSON over stdio
> **来源**: 源码为唯一权威来源——`packages/shared/rpcMethods.ts`（RPC method 名）和 `packages/protocol/src/push.ts`（PushMethods）。v2 起客户端走 `initialize` 拿 server capabilities。

---

## Overview

`taco-sidecar` is a long-lived server process. Clients communicate with it by writing NDJSON frames to its stdin and reading responses from its stdout.  The server may push frames to the client at any time — these have no `id` field.

```
Client → Server  { "id": "uuid", "method": "session.prompt", "params": { ... } }
Client → Server  { "id": "uuid2", "method": "workspace.ensure", "params": { "cwd": "..." } }
Server → Client  { "id": "uuid", "ok": true, "result": { ... } }     ← response
Server → Client  { "method": "session.event", "workspace": "...", ... }  ← push (no id)
Server → Client  { "id": "uuid2", "ok": true, "result": { ... } }     ← response
```

All frames are newline-delimited JSON.  A line containing only whitespace is ignored.

---

## Wire Types

### Request

```typescript
interface RpcRequest<TParams = unknown> {
    id: string;       // UUID; responses and pushes are matched by id
    method: string;
    params: TParams;
}
```

### Response

```typescript
type RpcResponse<TResult = unknown> =
    | { id: string; ok: true;  result: TResult }
    | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };
```

### Push

```typescript
interface ServerPush<TParams = unknown> {
    id?: string;           // present when push carries a deduplication key (e.g. tool call id)
    method: string;        // push method name
    workspace: string;     // cwd of the workspace this push belongs to
    session?: string;      // SessionId; absent for sessionless events
    sessionKind?: "main" | "subagent";
    params: TParams;
}
```

---

## Startup

Connection setup is a single `initialize` RPC. The server rejects every
RPC except `initialize` with code `not_initialized` until the handshake
succeeds, so clients must send it as their first call.

> **v1 → v2.** The `sidecar.hello` push frame that v1 used for liveness
> and identity is retired in v2. The readiness signal and identity
> fields (`serverVersion`, `pid`, `instanceId`, `protocolVersion`) now
> travel on the `initialize` response. v1 clients are not accepted
> against a v2 server.

### `initialize` (mandatory)

The client sends a single `initialize` request:

```json
{ "id": "<uuid>", "method": "initialize", "params": { "protocolVersion": { "major": 2, "minor": 0 }, "clientCapabilities": { "uiLocale": "en" } } }
```

The server validates the client's protocol version with `isCompatibleClientProtocol`
(major must match exactly; client minor must be `<=` server minor). The response is:

```json
{ "id": "<uuid>", "ok": true, "result": { "serverVersion": "0.1.0", "serverCapabilities": { "methods": [...], "pushes": [...], "channels": [...] }, "protocolVersion": { "major": 2, "minor": 0 }, "instanceId": "<uuid>", "pid": <pid> } }
```

After a successful initialize, every other RPC is accepted. `initialize` is idempotent
and outside `commandRecords` dedup. In-process self-RPC callers (e.g. the memory tool)
are not gated.

### Recommended client entry point

`@taco-ai/shared`'s `TacoClient.handshake()` sends `initialize`, validates the
returned protocol, and returns the typed `InitializeResult` — that is the
recommended single-call readiness check for any client that is going to call RPCs.

---

## RPC Methods

All method names are listed below, grouped by namespace.  The `workspace.*` methods are process-global; all others carry a `workspace` field in their params identifying the target workspace `cwd`.

<!-- RPC_TABLE_START -->
| Method | Namespace |
|--------|----------|
| `initialize` | initialize.* |
| `workspace.list` | workspace.* |
| `workspace.ensure` | workspace.* |
| `workspace.dispose` | workspace.* |
| `session.list` | session.* |
| `session.create` | session.* |
| `session.attach` | session.* |
| `session.detach` | session.* |
| `session.delete` | session.* |
| `session.rename` | session.* |
| `session.history` | session.* |
| `session.events.get` | session.* |
| `session.snapshot.get` | session.* |
| `session.tasks.get` | session.* |
| `session.taskHistory.get` | session.* |
| `session.planState.get` | session.* |
| `session.prompt` | session.* |
| `session.steer` | session.* |
| `session.abort` | session.* |
| `command_permission.resolve` | command_permission.* |
| `session.setModel` | session.* |
| `session.listModels` | session.* |
| `providers.list` | providers.* |
| `session.setThinkingLevel` | session.* |
| `session.compact` | session.* |
| `session.contextInfo` | session.* |
| `session.submitAnswers` | session.* |
| `provider.listModels` | provider.* |
| `settings.get` | settings.* |
| `settings.write` | settings.* |
| `extensions.status` | extensions.* |
| `channels.list` | channels.* |
| `channels.listConversations` | channels.* |
| `channels.create` | channels.* |
| `channels.bind` | channels.* |
| `channels.submitVerifyCode` | channels.* |
| `channels.unbind` | channels.* |
| `imPolicy.get` | imPolicy.* |
| `imPolicy.setChannelDefault` | imPolicy.* |
| `imPolicy.setChatOverride` | imPolicy.* |
| `imPolicy.clearChatOverride` | imPolicy.* |
| `tools.list` | tools.* |
| `agents.list` | agents.* |
| `agents.content` | agents.* |
| `skills.list` | skills.* |
| `skills.content` | skills.* |
| `checkpoints.list` | checkpoints.* |
| `checkpoints.restore` | checkpoints.* |
| `memory.list` | memory.* |
| `memory.write` | memory.* |
| `memory.deleteTopic` | memory.* |
| `memory.upsert` | memory.* |
| `mcp.listServers` | mcp.* |
| `mcp.getConfig` | mcp.* |
| `mcp.createConfig` | mcp.* |
| `mcp.updateConfig` | mcp.* |
| `mcp.deleteConfig` | mcp.* |
<!-- RPC_TABLE_END -->

### Error Codes

`RpcResponse.error.code` is a wire-stable string from a closed set. New codes
may be added in minor versions; renaming or removal is a major-version bump.
Clients should map unknown codes to a generic "internal error" rather than
assert equality against any of the constants below. The full table is exported
as `ErrorCodes` from `@taco-ai/protocol/errors`.

| Code | When |
|------|------|
| `invalid_params` | Caller-supplied params failed type/schema validation. `data.issues` (when present) carries `path: string[]` and `message` per failure. |
| `invalid_state` | Server state doesn't permit the requested operation (e.g. a `channels.*` call when channels are not bound). |
| `incompatible_protocol` | `initialize` handshake failed — client protocol version not compatible with the running sidecar. |
| `invalid_value` | A field was set but unusable (malformed env var, unsupported schema, etc.). |
| `not_found` | Resource not found (session, workspace, skill, …). |
| `id_conflict` | `memory.upsert` id conflict (target exists for `add`, missing for `replace`). |
| `memory.conflict` | `memory.write` lost the baseHash race — client must re-read and retry. `data` carries the current content and hash. |
| `snapshot_unstable` | Session snapshot was concurrently mutated mid-read. |
| `checkpoint_restore_failed` | `checkpoints.restore` failed (file changed under us, …). |
| `wechat_sdk_missing` | Channel SDK not installed for an optional-dependency channel. |
| `not_initialized` | RPC called before `initialize` completed. |
| `unknown_method` | Method name not in the sidecar's registry (capabilities handshake advertises the supported set). |
| `session_busy` | Another turn is already active for the same `(workspace, session)`. |
| `command_id_conflict` | `commandId` reuse with mismatched params. |
| `internal` | Catch-all server error. `data` may carry a redacted message — never raw stack traces. |

---

## Push Frames

The server pushes frames asynchronously.  Clients should route by `method`.

| Method | When |
|--------|------|
| `session.attached` | When a session is attached. |
| `session.detached` | When a session is detached. |
| `session.event` | Generic session events (message deltas, errors, tool results). |
| `session.error` | A session-level error occurred. |
| `session.tool_call_start` | Tool call initiated. |
| `session.tool_call_update` | Tool call producing partial/incremental output. |
| `session.tool_call_end` | Tool call completed (success or error). |
| `subagent.spawned` | A sub-agent was spawned by the harness. |
| `session.compaction_started` | Auto-compaction entered. |
| `session.compaction_finished` | Auto-compaction completed. |
| `tasks.updated` | Task list changed. |
| `plan.state.updated` | Plan mode state changed. |

<!-- PUSH_TABLE_START -->
| Push method | Constant |
|-------------|----------|
| `session.attached` | Attached |
| `session.detached` | Detached |
| `session.event` | Event |
| `session.tool_call_start` | ToolCallStart |
| `session.tool_call_update` | ToolCallUpdate |
| `session.tool_call_end` | ToolCallEnd |
| `command_permission.requested` | CommandPermissionRequested |
| `subagent.spawned` | SubagentSpawned |
| `session.error` | Error |
| `session.compaction_started` | CompactionStarted |
| `session.compaction_finished` | CompactionFinished |
| `tasks.updated` | TasksUpdated |
| `plan.state.updated` | PlanStateUpdated |
| `models.changed` | ModelsChanged |
| `session.deleted` | SessionDeleted |
| `channel.status_changed` | ChannelStatusChanged |
| `channels.conversations_changed` | ConversationsChanged |
| `im.tools_enabled` | ImToolsEnabled |
| `im.policy_changed` | ImPolicyChanged |
| `im.workspaces_invalidated` | ImWorkspacesInvalidated |
<!-- PUSH_TABLE_END -->

**Push routing note**: `session.tool_call_*` frames carry a deduplication `id` equal to the `toolCallId`.  Clients may use this to merge incremental updates.  All other push frames should be accumulated by `workspace` + `session`.

### Session Event Replay (tombstone & capacity)

Per-(workspace, session) push frames carry a `seq` field for gap detection
and replay recovery. This is a process-local best-effort log; the on-disk
`sessions/<workspace>/<sessionId>.jsonl` remains the authoritative history.

**Stream identity.** Each `(workspace, session)` pair has its own monotonic
`seq` counter starting at `1`. The counter never reuses a value, even across
session delete/recreate cycles.

**Replay window.** The sidecar keeps an in-memory ring of the most recent
events per stream (`capacity = 512`). When the ring fills, the oldest event
is evicted and `firstSeq` advances. Events older than the current `firstSeq`
are **unrecoverable through push replay** — clients that fall that far behind
must reset their cursor and reload.

**`session.deleted` tombstone.** The terminal `session.deleted` push frame
is appended at `seq = N + 1` (one past the last live frame) and the stream
is cleared after `TOMBSTONE_TTL_MS = 60_000` ms. A client reconnecting within
60s receives the tombstone frame and can surface "session was deleted" before
the stream disappears.

**`session.events.get { afterSeq }` semantics.** The handler returns:

```typescript
interface SessionEventReplay {
    events: ServerPush[];        // events with seq > afterSeq
    firstSeq: number;            // current ring's first seq (1 if stream empty)
    lastSeq: number;             // highest seq currently buffered (0 if stream empty)
    resetRequired: boolean;      // true when afterSeq < firstSeq - 1
}
```

- `resetRequired: false`, `events` non-empty → apply incrementally.
- `resetRequired: false`, `events` empty → already up to date.
- `resetRequired: true` → ring no longer covers the requested range; reset
  state and reload from `firstSeq` (or, for deletes, treat as fresh session).

**Not a wire guarantee.** This log is process-local and best-effort. Across
a sidecar restart the ring is empty (`firstSeq = 1, lastSeq = 0`) regardless
of `afterSeq`. Clients must always consult `resetRequired` before applying
events.

---

## Resolved Quirks (pre-1.0)

The following entries describe issues that were fixed before the v0.1.0
open-source release. Kept here as an audit trail of what changed in the
months leading up to the release.

### ~~`workspace.ensure` / `workspace.dispose` ignore `cwd` parameter~~ [fixed]

Resolved by registering both methods with `workspaceParam: "cwd"`; the
dispatcher now parses `params.cwd` and forwards it as the routing key. See
`tests/server/workspaceRouting.test.ts` for the regression test.

### ~~`memory.*` methods are declared but not implemented~~ [fixed]

Implemented in `packages/sidecar/src/server/handlers/memory.ts` (handlers
`memory.list`, `memory.write`, `memory.deleteTopic`, `memory.upsert`).
Tests: `tests/server/handlers/memory.test.ts`.

### Config precedence advertised wrongly

The current precedence is **CLI args > `taco.json` > `process.env`** (env
only feeds in via the `TACO_*` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
set documented in `Configuration File` below). `sidecar/config/config.ts`
is the authoritative source.

## Known Quirks

### `mcp.*` config changes require a sidecar restart for new tool exposure

`mcp.listServers` reads `mcpServers` from `taco.json` on every call (so
its output reflects the latest on-disk state), but the actual runtime
tool set is built once per workspace at attach time by `discoverMcpTools`.
Adding a server, toggling `enabled`, or editing `alwaysLoaded` only
takes effect for newly-attached workspaces; an already-running workspace
will not see the new tool until the sidecar restarts. The desktop MCP
settings UI exposes an "Apply & restart" button to make this explicit —
the button aborts every open workspace and any in-flight turn inside them;
the user sees this in the button's tooltip.

`mcp.listServers` skips servers with `enabled === false` and returns
`status: "skipped"` for them (without spawning the stdio child / opening
the HTTP connection). Pass `forceProbe: true` in the params to override
the skip and actually probe a disabled server — useful for the UI's
"refresh status" button when the user toggles a server back on. The
runtime candidate construction in `discoverMcpTools` also filters by
`enabled`, which is what makes the flag actually take effect at runtime.

MCP tool execution is not gated by the command-permission broker —
configuring a server is implicit authorization for every tool it exposes.

### `channels.bind` may fail with `wechat_sdk_missing`

Some channels depend on an `optionalDependencies` SDK so installs
without it still succeed. `channels.list` advertises the channel type
regardless of whether the SDK is installed, but `channels.bind` will
fail with the coded error `wechat_sdk_missing` until the user installs
the corresponding package. The `mock` channel used in tests does not
have this constraint.

---

## CLI Flags

```
taco-sidecar [--default-model <model>] [--sessions-root <path>]
             [--system-prompt <text>] [--thinking-level <level>]
             [--anthropic-api-key <key>] [--openai-api-key <key>]
```

| Flag | Default |
|------|---------|
| `--default-model` | none |
| `--sessions-root` | `~/.taco/sessions` |
| `--system-prompt` | none |
| `--thinking-level` | none |
| `--anthropic-api-key` | process.env |
| `--openai-api-key` | process.env |

---

## Configuration File

### Path

`$TACO_HOME/taco.json` (default `~/.taco/taco.json`). `$TACO_HOME` itself
falls back to `$HOME/.taco` when unset. The `taco.json` shape is shared
verbatim across the desktop and sidecar via `@taco-ai/protocol`
(`TacoGlobalConfigShape` in `protocol/src/config.ts`); the on-disk
schema is the source of truth.

### Other on-disk locations

| Path | Owner | Description |
|------|-------|-------------|
| `$TACO_HOME/sessions/<workspace>/<sid>.jsonl` | sidecar | Session transcript (`sessionsRoot` field). One directory per workspace; one JSONL per session. |
| `$TACO_HOME/sessions/im/<channelId>/` | sidecar | Per-channel IM session transcripts (only created when a channel is configured). |
| `$TACO_HOME/sessions/<sid>/tasks/` | sidecar | Per-session task store; colocated with the session's `.jsonl`. |
| `$TACO_HOME/channels/<channelId>.json` | channel SDK | Channel credentials. Permission `0600`. Not in `taco.json`. |
| `$TACO_HOME/checkpoints/<workspaceHash>/` | sidecar | Turn-scoped file snapshots. `index.json` + content-addressed `blobs/<sha256>`. |
| `$TACO_HOME/im-workspace-policies/<channelId>.json` | sidecar | Per-channel IM workspace policy (`imPolicy.*` admin surface). Survives unbind/rebind. |
| `$TACO_HOME/workspace/` | desktop | Default workspace cwd when the desktop has none (`default_workspace_dir` Tauri command). |
| `$TACO_HOME/desktop.json` | desktop | Client-only settings (onboarding status, etc.). Sidecar does not read this. |

See `packages/sidecar/src/config/config.ts` for the full schema.

---

## Stability

New fields may be added to push frame `params` objects in any minor version.  Removing or renaming fields constitutes a major version bump.  New RPC methods may be added in minor versions.  Existing method names and parameter shapes are stable.

---

## Maintenance

This document is generated from source.  Run `pnpm sidecar:docs` to regenerate the RPC/push method tables.  Hand-written sections (this overview, quirks, CLI flags) are preserved by `@manual` markers in the source.
