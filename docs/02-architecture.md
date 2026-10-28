# Architecture & Implementation

> How the sidecar's protocol layer, runtime, and client shape fit together,
> and why the boundaries are drawn where they are.

## 0. Project Highlights

What Taco adds on top of Pi's harness, from the code:

- **`agent` tool — subagents with fan-out.** Per-type tool whitelist, `agent/<type>` namespace, depth-bounded recursion, `executionMode: "parallel"` for concurrent calls.
- **`skill` tool — inline or subagent.** Loads by name; inline enqueues a `<skill_body name="NAME">` message protected by `skillReinjector`, subagent mode spawns a fresh session via `spawnSkillSubagent`.
- **Plan mode with a hard gate.** `planEnter` opens `.taco/plans/<slug>.md`; only read / askUser / write-the-plan are allowed; `planExit` returns the plan for approval.
- **Prompt tag system.** Each `<tag>` block carries a `compression` policy (`pin` / `pinOnce` / `summarize` / `drop`) and `tuiVisibility` (`visible` / `hidden` / `ephemeral`); the pin-aware compact hook reads that registry.
- **Extension system.** Capabilities plug in as extensions rather than being built into the runtime; workspace activation merges process and workspace contributions into one frozen `WorkspaceExtensionSet`, and an extension can contribute its own tags.
- **JSONL storage.** Sessions / history / event logs go through `JsonlSessionStorage` + `JsonlSessionRepo` — append-only, replayable, no schema migrations.
- **Pi as a dependency.** `@taco-ai/pi-harness` `0.1.0` and `pi-ai` `1.3.0`; consumes upstream APIs directly. `pi-harness` carries the `AgentHarness` API that Pi 1.0 removed from `pi-agent-core`, frozen at the `0.99.2` surface and running on the current `pi-ai` line.
- **Standalone deploy.** `@taco-ai/sidecar` is a standalone npm package with its own bin. It supports two running modes — direct `NDJSON over stdio` (any language can drive it that way) and the long-lived daemon mode used by `taco start` and the Tauri desktop. See §2.8.
- **One daemon, many workspaces.** One daemon serves every workspace the UI has open, routed by `cwd`, and the same NDJSON socket carries traffic from multiple clients concurrently.

## 0.1 What's Next

The harness surface is still under construction:

- **Plan / Tasks / Memory keep refining.** Reminder cadence, hook ordering, extraction prompt quality are still evolving.
- **Coding strength lands in extensions.** Patches / refactors / test runners go through the extension system.
- **Harden the safety envelope.** `PermissionBroker` already isolates read-only subagents and supports per-workspace IM policies; sandboxing and finer-grained IM policy are next.

## 1. Protocol layer

### 1.1 Transport: NDJSON over stdio or daemon socket

Each line is one JSON frame:

```
request:  {"id":"r1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}
response: {"id":"r1","ok":true,"result":{"cwd":"/tmp/x"}}
push:     {"id":"<uuid>","method":"session.event","workspace":"/tmp/x","session":"<id>","params":{"event":<AgentHarnessEvent>}}
```

Taco supports two transport modes over the same NDJSON line abstraction:

- **stdio mode** — direct child-process pipes (`process.stdin` / `process.stdout`).
  Each client owns its own sidecar process; lifetime is bound to the parent.
  This is the path documented in §3.2 for the typed Node client and the
  integration examples.
- **daemon mode** — the sidecar runs as a long-lived process and accepts
  multiple clients over a Unix domain socket (`<runtime>/sidecar.sock`,
  Windows: `\\.\pipe\taco-sidecar-<slug>`) for NDJSON traffic, with a separate
  control socket (`<runtime>/sidecar-ctl.sock`, Windows: `\\.\pipe\taco-sidecar-ctl-<slug>`)
  for `start` / `status` / `stop`. The Tauri desktop and `taco start` use
  this mode. See §3.3 for the desktop side and §2.6 for tenant isolation
  semantics.

The NDJSON `line` abstraction is identical across both modes — the
typed client does not need to know which transport it sits on. Mode is
chosen by how the sidecar is launched (env flags for the `cli`, Tauri
config for the desktop).

Why NDJSON rather than anything else:

- **Zero dependencies** — only Node's built-in `readline` + `process.stdout` / `process.stdin` in stdio mode; a Unix socket reader in daemon mode.
- **Natural fit for child-process pipes** — `subprocess.stdin/.stdout` are already there; no extra transport layer.
- **Human-readable** — `cat` the stream to see what happened (stdio mode).
- **Transport-swappable** — HTTP / WebSocket are alternate transports; the NDJSON `line` abstraction stays the same.

### 1.2 Frame types

#### Pull request / response (JSON-RPC style)

```typescript
interface RpcRequest<TParams = unknown> {
    id: string;       // client-generated, used to pair response
    commandId?: string; // retry identity for deduplicated mutations
    method: string;   // e.g. "workspace.ensure" or "session.prompt"
    params: TParams;
}

type RpcResponse<TResult = unknown> =
    | { id: string; ok: true; result: TResult }
    | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };
```

#### Push (server-initiated)

```typescript
interface ServerPush<TParams = unknown> {
    id?: string;              // optional, mainly used for client-side dedupe
    method: string;           // "session.event" / "session.attached" ...
    workspace: WorkspaceId;  // primary routing key
    session?: SessionId;     // secondary routing key (optional)
    seq?: number;           // per-session replay cursor
    sessionKind?: "main" | "subagent";  // routes push to right pane in the desktop
    params: TParams;
}
```

Push frames carry their own `method` — clients route by `method`, not
by `id`. Pull responses pair by `id`; push ids are optional deduplication keys.

### 1.3 Contract and validation

The RPC and push inventories in `docs/sidecar-protocol.md` are regenerated
by `pnpm sidecar:docs`. Requests are defined once in
`packages/protocol/src/schemas/<domain>.ts`; params types derive from the
schema. A row in `rpcContract/<domain>.ts` binds the wire name, client
routing scope, schema and result type, generating `RPC`, `rpcContract`
and `rpcSchemas`. Push names and payload DTOs live in `push.ts`.

`registerMethod` checks handler types against the row. The server validates
params before resolving a workspace or invoking a handler, returning
`invalid_params` with `data.issues` field paths on schema failures. It does
not cast or strip input. Handlers own authorization, state, conflicts and
cross-field rules. `initialize` deliberately delegates validation to its
negotiation handler; config patch bodies stay open. Result and push payload
types currently have no runtime schemas.

The shared facade and internal self-RPC calls use the same contract.
Compile-time guards check coverage, typed params and client routing scopes;
JSON round-trip tests check the payloads sent by every facade method.

### 1.3.1 Protocol boundaries

- The main data channel uses the contract above over stdio or a daemon socket.
- The daemon control socket uses a separate request/reply format for
  `control.ping` and `control.shutdown`; it is handled by `controlChannel.ts`
  and `shared/controlNode.ts`, outside the data-channel contract.
- Desktop React ↔ Rust commands/events are Tauri IPC. `workspace_send` wraps
  the serialized data frame as `{ cwd, line }`; Rust forwards the line without
  interpreting the RPC. `desktop_config_*`, filesystem grants and upgrade
  commands are desktop APIs, not entries in the data RPC table.

Desktop settings merge `{ global, client, loaded }` after `settings.get`
returns `{ global }`. Client preferences and `desktop.json` stay desktop-owned.
Extra fields in a main RPC are governed by its schema; no-param envelopes
and the `settings.write` envelope reject unknown keys.

### 1.4 Routing keys

- **`workspace` (primary key)** — absolute cwd, resolved and normalized. A separate prefix `im://<channelId>/<peerId>/<chatId>` is used for IM workspaces (see `protocol/src/channels.ts`).
- **`session` (secondary key)** — server-generated `uuidv7`. The client may pass a specific id to reuse one.

**Why cwd rather than a workspace name?** Cwd is a filesystem-level
project identifier; the existing `pi-coding-agent` model also uses cwd
to isolate sessions. Avoiding a separate namespace prevents collisions
with other tooling.

## 2. Runtime

### 2.1 Three-layer structure

```
┌──────────────────────────────────────────────────────────────────┐
│ SidecarServer  (singleton, owns Map<cwd, WorkspaceRuntime>)        │
│  ├─ Handles RPC dispatch via methodRegistry (RPC[key] → handler)  │
│  ├─ Owns workspaceMap, channelRegistry, channelBindBroker          │
│  └─ Forwards push frames (session.event / tools.updated / ...)     │
└─────────────┬────────────────────────────────────────────────────┘
              │ 1:N
┌─────────────▼────────────────────────────────────────────────────┐
│ WorkspaceRuntime  (one per cwd; holds NodeExecutionEnv + Repo)     │
│  ├─ Owns JsonlSessionRepo (cross-session .jsonl list)              │
│  ├─ Owns Models (createModels) and McpToolProvider                  │
│  ├─ Caches metadata list (workspace-level)                          │
│  ├─ Owns SessionRegistry + AgentSpawner + ModelRegistry             │
│  └─ Maintains attached: Map<sessionId, AttachedSession>             │
└─────────────┬────────────────────────────────────────────────────┘
              │ 1:N
┌─────────────▼────────────────────────────────────────────────────┐
│ AttachedSession  (one Session + one AgentHarness)                   │
│  ├─ Owns Session (open from JsonlSessionStorage)                    │
│  ├─ Owns AgentHarness (harness.subscribe forwards events)           │
│  ├─ Owns per-session TaskStore + PlanModeState + ImPolicyState     │
│  ├─ Owns SessionToolController (deferred tool loading)              │
│  └─ Exposes prompt / steer / abort / setModel / compact             │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 WorkspaceRuntime

**Responsibilities**

- Owns `NodeExecutionEnv` (cwd-bound file system + shell)
- Owns a `JsonlSessionRepo`, listing historical `.jsonl` per cwd
- Owns `SessionRegistry`, which manages all attached sessions
- Owns `AgentSpawner` (subagent creation + `agentContinue` resume)
- Owns `ModelRegistry` (built-in + custom + MCP tool candidates)
- Owns `PermissionBroker` (5-level risk classification + rule-based allow/deny)
- Owns `Checkpoints` (turn-scoped pre-write file snapshots)

**Key surface**

```typescript
class WorkspaceRuntime {
    async listSessions(): Promise<JsonlSessionMetadata[]>
    async getHistory(sessionId): { leafEntryId, entries }

    async attach(sessionId): Promise<AttachedSession>
    async detach(sessionId): void
    getAttached(sessionId): AttachedSession

    listAvailableModels(provider?: string): ModelInfo[]
    async setSessionModel(sessionId, provider, modelId): Promise<void>
    async spawnSubagent(args): Promise<{ subSessionId, resultText, isError }>
}
```

`_metadataCache` caches the workspace's session metadata. **Only
invalidated after explicit mutate** (create / delete / rename); read
operations (e.g. `session.list`) hit the cache.

### 2.3 AgentHarness event flow (push channel)

`AgentHarness` has its own event bus. The `AgentHarnessEvent` union
includes `message_start / message_update / message_end / turn_end / agent_end / tool_execution_{start,update,end}`.

`AttachedSession` subscribes via `harness.subscribe(listener)` and
re-emits on its own `EventEmitter`:

```typescript
const unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
    attached.emit("event", event);
});
```

`WorkspaceRuntime` then forwards as `session.event`:

```typescript
attached.on("event", (e) => this.emit("session.event", { sessionId, event: e }));
```

`SidecarServer` serializes into NDJSON frames:

```typescript
ws.on("session.event", (e) => {
    this.emitPush(PushMethods.Event, workspaceKey, e.sessionId, { event: e.event });
});
```

Tool events are split into named push methods
(`session.tool_call_start / _update / _end`) so the client dispatcher
can route by method without re-parsing `session.event` payloads. The
`id` field of the tool push frame equals the `toolCallId`, giving the
client a deduplication key.

### 2.4 AttachedSession — concurrency and tools

Each AttachedSession owns its own AgentHarness instance. The harness's
`phase` field (`"idle" | "turn" | "compaction" | "branch_summary"`) is
**instance-level** state: calling `prompt()` while non-idle throws
`AgentHarnessError("busy")`.

Concurrency is therefore scoped to the **session**, not the workspace:

- Multiple sessions in the same workspace run **fully in parallel** —
  each holds an independent AgentHarness, so their phases never collide.
- Multiple workspaces are fully parallel as well.
- The only serialized case is **concurrent turns on the same session**:
  the sidecar rejects these at the RPC layer, keyed by
  `(workspace, sessionId)`, with `session_busy` (see 2.8). This keeps
  user messages from interleaving on one conversation branch.
- Subagents run in their **own child session** with a restricted toolset
  (whitelist + depth-based recursion guard) and the `agent` tool
  spawns them; being separate sessions, they run in parallel with the
  parent.

Tool loading is dynamic:

- Tools marked `loading: "always"` are attached at session start (or fail
  the attach, which the UI surfaces as "restart and retry").
- Tools marked `loading: "deferred"` are listed by `addTools` and
  loaded on demand. Each load is serialized through
  `SessionToolController`'s promise chain so concurrent calls never merge
  on a stale snapshot.
- Persisted as `active_tools_change` entries in the transcript, so
  re-attach after restart restores the same tool set.

### 2.5 Channel layer (IM)

```
┌─────────────────────────────────────────────────────┐
│ ChannelRegistry  (loaded channel instances)            │
│  ├─ Channel / ChannelHandle per channelId              │
│  ├─ ChannelBindBroker (status / pending verify codes) │
│  └─ Per-channel OutboundSink + serial push chain       │
└─────────────────┬───────────────────────────────────┘
                  │ tracks 1:N
┌─────────────────▼───────────────────────────────────┐
│ WorkspaceRuntime (im:// path)                          │
│  ├─ NodeExecutionEnv at $TACO_HOME/sessions/im/.../   │
│  ├─ ConversationRouter (peer/chat → session)           │
│  ├─ ImWorkspacePolicy (per-channel defaults + chat)   │
│  └─ fs tools DISABLED (IM_DISABLED_FS_TOOLS)          │
└─────────────────────────────────────────────────────┘
```

The channel layer is **independent** of the regular workspace layer:
IM workspaces use a virtual `im://` cwd, share the same
`SidecarServer`, but get a separate `WorkspaceRuntime` with FS tools
disabled. IM policy is layered on top of the global command permission
broker and the per-channel defaults: `commands.mode` uses the same
manual/automatic semantics and replaces the global mode, while
`commands.allow` / `commands.deny` are appended to the global lists.

### 2.6 Configuration loading

The chain (later overrides earlier):

```
env (TACO_*, ANTHROPIC_API_KEY, etc.)
  → $TACO_HOME/taco.json
  → CLI args
```

The on-disk `taco.json` shape is `TacoGlobalConfigShape` in
`packages/protocol/src/config.ts`. Fields:

- `defaultModel` / `defaultProvider` — model selection
- `systemPrompt` — global system prompt prefix
- `thinkingLevel` — default for new sessions
- `apiKeys` / `anthropicApiKey` / `openaiApiKey` — provider credentials, mirrored to `process.env` via `ProviderKeyStore`
- `sessionsRoot` — `.jsonl` storage location (default `$TACO_HOME/sessions/`)
- `compaction` — `{ enabled, threshold }` (defaults `true` / `0.7`)
- `commandPermissions` — `{ mode: "ask" | "auto", allow?: string[], deny?: string[] }`; deny matches require approval and take precedence over allow, while unmatched commands ask in `ask` mode and auto-pass in `auto` mode. A built-in denylist (recursive force-delete, `git reset --hard`, force push, publish, uploads, infrastructure teardown) always asks once, in both modes, and no allow rule overrides it. Allow wildcards match each command of a compound command separately; only an exact rule can allow the whole text. Commands that run another command (`eval`, `xargs`, `nohup`, …) ask unless exactly allowed. In `ask` mode, strict read-only Git inspection runs without a prompt. Legacy `rules` is read as `allow` when `allow` is absent. `allowedDirectories` adds absolute roots that `cd` may enter besides the working directory.
- `customProviders` — third-party OpenAI/Anthropic-compatible endpoints (id must have `custom:` prefix)
- `mcpServers` — per-server stdio / Streamable HTTP MCP config
- `channels` — IM channel instances (manifest + channel-specific config)
- `extensions` / `disabledExtensions` — npm extension allowlist
- `instructions` — project-context instruction file toggles (CLAUDE.md / AGENTS.md / DESIGN.md)

The **safe view** (`TacoGlobalConfigView`) returned by `settings.get`
strips every secret-bearing field before it crosses the IPC boundary:
API keys become `MaskedKey`, and `mcpServers[i].{env,headers,command,args,url,cwd}`
plus `channels[i].config` are dropped.

### 2.7 MCP tool integration

`mcpServers` is a top-level field. Each server entry has `transport:
"stdio" | "http"` plus connection params. The lifecycle:

1. **Discover** — at workspace attach, `discoverMcpTools` parallel-connects
   and lists tools, mapping each as a `ToolCandidate` named
   `mcp__<serverId>__<toolName>` (sanitize + dedupe). The candidate is
   added to `DeferredToolRegistry` as `deferred` (or `always` if listed
   in `alwaysLoaded`).
2. **Load** — `addTools` calls `load(name)` on the registry. The
   adapter wraps the `McpToolInfo` as an `AgentHarnessTool`; the
   `inputSchema` flows through as `parameters`.
3. **Call** — `McpToolAdapter.execute` calls `McpClientHandle.callTool`
   reusing the open connection.
4. **Teardown** — `WorkspaceRuntime.dispose()` closes all
   `McpClientHandle`s.

Security: **MCP tool execution does NOT go through `PermissionBroker`**.
The `McpServerConfig` doc-comment in `protocol/src/config.ts` calls this
out explicitly: configuring a server is implicit authorization for
every tool it exposes. The desktop MCP settings UI must surface this in
its `mcpServersDesc` i18n string.

Failure isolation: a single server that fails `discoverMcpTools` or a
single tool call failure only produces `log.warn` and an `isError` result
on the tool. Other servers continue.

**Restart is required** when `mcpServers` changes: the runtime tool set
is built once at attach. `mcp.listServers` reflects the on-disk state
in real time, but a new server / `enabled` toggle / `alwaysLoaded`
change takes effect for newly-attached workspaces only. The desktop
MCP settings pane provides an "Apply & restart" button that makes this
explicit.

### 2.8 Daemon scope and tenant isolation

The runtime has two running modes, with different isolation semantics:

- **stdio mode** — each client owns its own sidecar process, lifetime
  bound to the parent. Tenant isolation = start another process.
- **daemon mode** — the sidecar runs as a long-lived process bound to a
  single control socket (`<runtime>/sidecar-ctl.sock` on Unix,
  `\\.\pipe\taco-sidecar-ctl-<slug>` on Windows). The control socket also
  serves as the single-instance lock: a second `taco start` against
  the same control endpoint reuses the existing daemon rather than
  spawning a new one. Tenant isolation in daemon mode is therefore
  *another control endpoint*, not *another process*. Export a different
  `TACO_RUNTIME_DIR` before each `taco start` so the data + control
  sockets land on a different path (Unix: a different directory;
  Windows: a different pipe slug derived from that directory).

Within one daemon, a single `SidecarServer` owns the workspace registry,
attached sessions, command-idempotency gate, channels and sequenced event log.
The scheduler dispatches into that same runtime. `ConnectionServer` holds only
its transport, initialization state and client capabilities; responses return
to the requesting connection, while pushes for both filesystem and IM workspaces
fan out to all initialized clients, including session events and permission
requests. Scheduled runs may wait for desktop approval when a client is connected;
without an interactive client, approval requests are denied immediately.
Disconnecting a socket does not abort sessions or release workspace resources.

`WorkspaceRegistry` transitions each key through starting, ready and closing.
Concurrent construction is shared; closing entries are hidden from reads and
new callers wait for disposal before rebuilding. Invalidated constructors
release their resources rather than publishing them. Shutdown prevents new
construction and attempts every close even if one resource fails.

Configuration writes use `ConfigStore` transactions across every entry point.
The owner-token lock covers reading, deriving collection edits and atomic
replacement. A live lock is never reclaimed by age; contention fails after one
second. Reads detect external atomic replacements. Reconnection and workspace
access re-resolve configuration with CLI overrides. `settings.write` and approved
`config.patch` writes await this same refresh path. Each effective change is
applied once; catalogs reconcile before defaults are resolved and model changes
are announced after application. Hot updates preserve running sessions. MCP, memory, system prompt
and default thinking settings are captured at workspace construction: new
workspaces use the refreshed defaults, while existing ones retain their snapshot
until explicitly released or the daemon restarts. Neither configuration refresh
nor MCP configuration writes dispose workspaces on the request path. Channels
and extensions still require a daemon restart.

Server-generated notices currently carry rendered text in the shared push frame.
The initiating request's locale determines that text; IM ingress without a client
request context defaults to English. Notices are not localized per recipient.

Sessions in separate workspaces or with different ids can run concurrently.
`CommandIdempotencyGate` serializes turn commands by `(workspace, sessionId)`
and deduplicates command retries across client connections.

## 3. Clients

### 3.1 Client tiers

```
┌─────────────────────────────────────────────┐
│  @taco-ai/protocol (types + schemas)        │  → wire contract for any consumer
└─────────────────┬───────────────────────────┘
                  │ used by
┌─────────────────▼───────────────────────────┐
│  @taco-ai/shared  (TacoClient / typed RPC)    │  → any Node / tsx process
│  + tacoClientNode (Node-side adapter)         │
└─────────────────┬───────────────────────────┘
                  │ consumed by
       ┌──────────┴────────────┐
       ▼                       ▼
┌─────────────────────┐  ┌─────────────────────────────────┐
│ Node TUI examples   │  │ @taco-ai/desktop (Tauri 2)        │
│ (third-party)       │  │ Rust spawns sidecar + React UI   │
└─────────────────────┘  └─────────────────────────────────┘
```

### 3.2 `@taco-ai/shared` design

`TacoClientBase` owns the frame buffer, dispatcher, subscriptions and typed
facade injection. The Node `TacoClient` supplies child-process transport,
`start()` / `dispose()` and a version-checking `handshake()`. The desktop
`TacoClient` supplies Tauri transport and reconnect handling.

`createTypedRpc(dispatch)` adapts friendly arguments into wire envelopes;
`createContractDispatch` checks them against the contract:

- `call(method, workspace, params)` — workspace-scoped RPC.
- `callProcess(method, params)` — process-scoped RPC.

Client scope is independent of server `ensureWorkspace`; lifecycle and
association-resolution calls need no pre-existing runtime. The jobs facade
uses `createProcessContractDispatch`; `config.patch` is model/internal-facing.

`FrameDispatcher` first recognizes responses by boolean `ok` and pairs them
with pending requests by `id`. Other frames with a string `method` are pushes,
even if they carry an id matching a request. Unrecognized frames emit warnings.

### 3.3 `@taco-ai/desktop` Tauri shell

The desktop connects to the **sidecar daemon**, not to a UI-owned stdio
child. Daemon lifecycle is managed by the `cli` package and the OS
service registration (when applicable); the desktop just attaches to
the data socket and reconnects on failure.

- **Rust backend (`src-tauri/src/lib.rs`)**:
  - `workspace_ensure(cwd)` — connect to the shared sidecar daemon's NDJSON
    socket (or prewarm one); idempotent. The desktop does not spawn a
    child process or pipe stdin/stdout.
  - `workspace_send(cwd, line)` — write a single NDJSON frame to the
    daemon's data socket. `cwd` is API-compat only; the sidecar routes on
    `params.workspace` per the protocol.
  - `workspace_dispose_all()` — drop the desktop-side socket connection;
    the daemon continues running until a tray Quit or `taco stop` requests
    shutdown. See **Lifecycle: close ≠ quit** in `clients/taco-desktop/README.md`
    for the full desktop shutdown contract.
  - `set_fs_scope(path)` — grant the FS plugin access to a path.
  - `desktop_config_read` / `desktop_config_write` — read / write
    `~/.taco/desktop.json` (the only file the desktop owns).
  - `default_workspace_dir` — return `$TACO_HOME/workspace/`,
    `mkdir -p` if missing.
  - `paths_are_dirs` — bulk check existence (used to prune
    invalid cwds in the sidebar's localStorage).
  - Forwards every received NDJSON frame as a Tauri event
    `sidecar-event { line }`.
  - On socket loss, emits `sidecar-exited { code?, reason? }` so the
    client can reject every pending RPC and start the bounded
    reconnect loop.

- **React frontend (`src/`)**:
  - `lib/clients/tacoClient.ts` — typed `TacoClient` over the Tauri transport;
    owns the reconnect state machine described in the desktop README.
  - `App.tsx` — workspace sidebar + session list + chat pane + settings
    + plugins + skills + agents + channels + memory panes; all driven
    by the same state machine.

**Rust gotcha** (worth keeping in mind):

- `#[tauri::command] async fn` receives `State<'_, ...>`. Holding the
  lock across `.await` deadlocks. Pattern: clone the needed
  `mpsc::Sender` inside `lock()`, release the lock, then `send().await`.

## 4. Data flow examples

### 4.1 One complete prompt

```
client                    sidecar stdout         sidecar internals
  │                             │                       │
  │── RpcRequest (init) ───────>│                       │
  │                             │  handshake complete   │
  │<── RpcResponse (init OK) ───│                       │
  │                             │                       │
  │── RpcRequest (prompt) ─────>│                       │
  │                             │  dispatch →           │
  │                             │  WorkspaceRuntime.attach      │
  │                             │  AttachedSession.prompt       │
  │                             │      ↓                AgentHarness.prompt
  │                             │      ↓                ├─ message_start (push)
  │<── push: message_start ─────│<─    │                │
  │                             │      ↓                ├─ message_update (push, repeated)
  │<── push: message_update ────│<─    │                │
  │                             │      ↓                ├─ message_end (push)
  │<── push: message_end ───────│<─    │                │
  │                             │      ↓                ├─ turn_end (push)
  │<── push: turn_end ─────────│<─    │                │
  │                             │      ↓                ├─ agent_end (push)
  │<── push: agent_end ────────│<─    │                │
  │                             │      ↓                ├─ tool_call_start (named push)
  │<── push: tool_call_start ───│<─    │                │
  │                             │      ↓                ├─ tool_call_end (named push)
  │<── push: tool_call_end ─────│<─    │                │
  │                             │                       └─ return assistantMessage
  │<── RpcResponse (assistant)──│                       │
```

### 4.2 Why push comes before response

`prompt()` is synchronous (it awaits the complete reply before resolving),
but LLM streaming output needs to be visible in real time.

The trade-off:

- **Async streaming** — once streaming starts, push frames flow
  immediately. The client sees token-level deltas before the
  `prompt()` RPC resolves.
- **Pull history on demand** — `session.history` returns the full
  chat tree (`leafEntryId` + `entries`); the client replays branches
  client-side.
- **Persistent push** — `session.event` keeps emitting
  `AgentHarnessEvent` for every step (tool calls, model changes,
  compaction, etc.).

Combined: the client **first pulls full history to reconstruct
context, then subscribes to push for ongoing deltas**.

### 4.3 IM channel round-trip

```
IM peer        Channel SDK          sidecar                       desktop
  │                  │                │                            │
  │── text msg ────>│                │                            │
  │                  │──onMessage──>  │                            │
  │                  │                │──ConversationRouter.route()│
  │                  │                │  (peer/chat → sessionId)   │
  │                  │                │                            │
  │                  │                │──ingress.submit() (RPC)────>│
  │                  │                │  session.prompt (im cwd)   │
  │                  │                │                            │
  │                  │                │<─push: session.event ──────│
  │                  │                │  message_start / update…   │
  │                  │                │                            │
  │                  │                │──channel.push(text)────────>│
  │                  │                │  extractReplyText + chunk  │
  │                  │                │                            │
  │<─ reply text ───│<─sdk.send()────│                            │
  │                  │                │                            │
  │                  │                │<─push: im.tools_enabled ───│  (first time only)
```

The sidecar's channel handle `push` extracts assistant text via
`extractReplyText` (skips thinking blocks, tool calls, tool results),
chunks it to fit the channel's per-message length budget, and calls
the SDK's `send` method. Reverse request flow (QR scan, pairing code)
goes through `ChannelBindBroker.requestScan` / `requestVerifyCode`
which publishes `channel.status_changed` push frames so the desktop
can render the binding UI live.
