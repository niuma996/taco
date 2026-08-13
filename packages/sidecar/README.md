# `@taco-ai/sidecar`

The Taco sidecar: an NDJSON-over-stdio JSON-RPC server wrapping Pi's
`@earendil-works/pi-agent-core` AgentHarness. One process hosts many
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
- **Subagents.** `agent` / `agentContinue` tools spawn a child
  session with a per-agent whitelist and a depth-based recursion
  guard.
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

## Optional dependencies

Channel SDKs are declared as `optionalDependencies` so installs without
them still succeed. `channels.list` advertises each channel type
regardless of whether the SDK is installed, but `channels.bind`
returns the channel's `<channel>_sdk_missing` error so the desktop
can offer a one-click install.

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
