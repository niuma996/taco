# `@taco-ai/sidecar`

The Taco sidecar: an NDJSON-over-stdio JSON-RPC server wrapping Pi's
`@taco-ai/pi-harness` AgentHarness. One process hosts many
workspaces and many sessions; the desktop / CLI / Python / TUI
clients all drive it via the same protocol.

## Install

```bash
pnpm add @taco-ai/sidecar
```

Or run from source (no install needed):

```bash
pnpm dev:sidecar   # tsx watch packages/sidecar/src/index.ts
```

## What it does

- **Multi-workspace routing.** Workspace is the primary key
  (`cwd` for IDE/CLI workspaces, `im://<channelId>/<peerId>/<chatId>`
  for IM). Each workspace has its own `WorkspaceRuntime`, and every
  session inside it owns an independent `AgentHarness` — so sessions
  and workspaces both run fully in parallel. Only concurrent turns on
  the *same* session are serialized, via a `(workspace, sessionId)`
  gate that returns `session_busy`.
- **Dynamic tool loading.** Tools are split into `loading: "always"`
  (resident from session start) and `loading: "deferred"`
  (loaded on demand via the `addTools` tool). MCP servers,
  skill subagents, and other sources populate the candidate
  pool via `DeferredToolRegistry`.
- **IM channels.** A pluggable Channel SDK (`Channel` +
  `ChannelHandle`); channels are added as opt-in dependencies.
- **Permission broker.** 5-level risk classification (readOnly /
  workspaceWrite / externalSideEffect / destructive /
  privilegeEscape) with rule-based ask / allow / deny and
  per-(channel, chat) IM policy overrides.
- **Subagents.** `agent` creates a child session with a per-agent whitelist
  and a depth-based recursion guard. `chatToAgent` messages or resumes an
  existing child; `listAgentSessions` discovers communicable instances,
  including same-parent siblings for a child. `agentContinue` has been removed;
  historical calls are displayed as ordinary tool records.
- **Checkpoints.** Turn-scoped pre-write file snapshots; restore
  is exposed as `checkpoints.restore` but never as a model tool
  (destructive, human-driven only).
- **Memory / tasks / plan / skills / agents** — see
  `packages/sidecar/src/{memory,tasks,plan,skills,agents}/`.

## Architecture

See [`docs/02-architecture.md`](../../docs/02-architecture.md) for
the full three-layer structure (`SidecarServer` →
`WorkspaceRuntime` → `AttachedSession`) and how push frames flow
back to the client.

## CLI

```bash
taco-sidecar [--default-model <id>] [--default-provider <id>] \
             [--sessions-root <dir>] [--system-prompt <text>] \
             [--thinking-level <off|minimal|low|medium|high|xhigh|max>] \
             [--anthropic-api-key <key>] [--openai-api-key <key>]
```

All flags have `TACO_*` env equivalents and `taco.json` config
overrides (see [`docs/03-config.md`](../../docs/03-config.md)).

## Configuration loading

```
env (TACO_*, ANTHROPIC_API_KEY, …)
  → $TACO_HOME/taco.json
  → CLI args
```

`$TACO_HOME` defaults to `~/.taco` (override with `TACO_HOME`).
Secret-bearing fields (`apiKeys`, `mcpServers[i].{env,headers,…}`)
are stripped before they cross the IPC boundary — see
`TacoGlobalConfigView` in `@taco-ai/protocol`.

## Agent communication

Use `agent` for new work in a new session and `chatToAgent` when an existing
agent needs clarification, new context, or continued work. Follow-ups are
optional. `listAgentSessions` lists instances with status, resumability, and
delivery capability; the agent catalog lists types.

`chatToAgent` defaults to `background: true` and `delivery: "steer"`. A queued
or started receipt means accepted, not completed. `background: false` works
only from a parent to its own idle child. Standard-engine steer arrives at the
next tool batch; `followUp` waits until the current run finishes. The original
parent still receives completion notifications. A missing result file means
output is unavailable; it does not establish that the agent is still running.

A parent can message its children; a child can message only siblings with the
same parent, never itself or the parent. Communication does not grant recursive
spawning or permission to abort siblings. Peer messages are collaboration data,
not user instructions or new authorization. Later parent conversation context
is not automatically synchronized, even after a fork; send it explicitly.
Guidance is shown only when the corresponding communication tool is available.

## Optional dependencies

Channel SDKs are declared as `optionalDependencies` so installs without
them still succeed. `channels.list` advertises each channel type
regardless of whether the SDK is installed, but `channels.bind`
returns the channel's `<channel>_sdk_missing` error so the desktop
can offer a one-click install.

`@napi-rs/canvas` is an optional dependency. The `read` tool uses it to
rasterise scanned PDF pages. It is a native binary, 30-40MB per platform, so
it is not bundled, and a release install has no `node_modules` beside the
bundle. Install it into `$TACO_HOME/vendor` when a scan needs rendering:

```bash
npm install --prefix ~/.taco/vendor @napi-rs/canvas@1.0.13
```

Without it a scan still reads, and the result names that command.

Agents with `runtime: claude-code` run on the user's own Claude Code CLI
(`claude` on PATH, signed in) through `@anthropic-ai/claude-agent-sdk`.
The SDK is not declared as a dependency at all — it carries a ~240 MB
platform binary taco does not need — and is loaded at run time, either
from normal resolution or from `$TACO_HOME/vendor`:

```bash
npm install --prefix ~/.taco/vendor --omit=optional @anthropic-ai/claude-agent-sdk
```

### Claude Code resume and retention

`chatToAgent` can continue Claude Code agents through native resume when Taco
has the saved native session mapping and state. Effective delivery while a run
is active is `nextTurn`, which does not guarantee interruption of an active
tool. Old CC display sessions without the native mapping/state cannot be
retroactively restored from Taco history alone.

Native Claude session logging is enabled to support resume. Deleting a Taco
display session does not actively delete the corresponding Claude Code native
session records. Those records follow Claude Code's storage configuration and
retention behavior; Claude Code or the user manages cleanup. Taco display
history and native Claude history have separate lifecycles.

## Build

```bash
pnpm -F @taco-ai/sidecar build      # bundle via esbuild → dist/
pnpm -F @taco-ai/sidecar package:runtime --target <triple>
                                    # produce release-stage binary per triple
```

Release builds are consumed by `@taco-ai/desktop`'s Tauri bundle
(`externalBin` + `resources/sidecar/`) and by npm-packaged
installs that bring their own `node`.

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
