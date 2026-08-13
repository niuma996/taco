# Taco — Goal & Scope

> Answers "what Taco is, why it exists, and what it does not do."

## One-line definition

**Taco** is a **minimal-viable sidecar protocol layer + multi-client debug
terminal** that drives multi-workspace, multi-session agent
conversations over an **NDJSON-over-stdio JSON-RPC protocol**, so any
client in any language can pull history, subscribe to push events, and
attach to ongoing turns. The agent runtime comes from Pi
(`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`); see
[Dependencies & roadmap](#dependencies--roadmap) for the split.

## Why this project exists

Taco started as a greenfield repository. The motivation:

- **A general client protocol for agent harnesses is missing.**
  Pi has already dropped the agent engine into `pi-agent-core`
  (`AgentHarness` provides multi-hook events; session persistence is
  abstracted by `pi-agent-core/harness/session`).
- **The Tauri + NDJSON pattern is already proven.** A prior
  experiment showed "Tauri + NDJSON over stdio" works, just bound to
  one project's own sidecar.
- **Taco extracts the cross-project seam.** A standalone sidecar
  (`@taco-ai/sidecar`) with a typed Node client (`@taco-ai/shared`),
  a typed wire contract (`@taco-ai/protocol`), and a Tauri 2 + React
  desktop.

## Scope (In Scope)

| Capability | Description |
|-----------|-------------|
| **Protocol layer** | NDJSON over stdio + JSON-RPC style (pull request/response + push stream) |
| **Runtime** | One sidecar process hosts **many workspaces + many sessions**, keyed by `cwd` |
| **Handshake (v1.0+)** | Mandatory `initialize` RPC after hello; the server rejects all non-`initialize` calls with `not_initialized` until the handshake completes. See `docs/sidecar-protocol.md` for the full contract. |
| **Pull interface** | `workspace.list / ensure / dispose`, full `session.*` lifecycle (create / attach / detach / delete / rename / history / events.get / snapshot.get / prompt / steer / abort / setModel / setThinkingLevel / compact / contextInfo / submitAnswers / tasks.get / taskHistory.get / planState.get / listModels), `providers.list`, `provider.listModels`, `settings.get/write`, `extensions.status`, `agents.list/content`, `tools.list`, `skills.list/content`, `memory.list/write/deleteTopic/upsert`, `command_permission.resolve`, `mcp.listServers/getConfig/createConfig/updateConfig/deleteConfig`, `channels.list/listConversations/create/bind/submitVerifyCode/unbind`, `imPolicy.get/setChannelDefault/setChatOverride/clearChatOverride`, `checkpoints.list/restore` |
| **Push events** | `sidecar.hello`, `session.attached / detached / event / error / deleted`, `session.tool_call_{start,update,end}`, `subagent.spawned`, `session.compaction_{started,finished}`, `tasks.updated`, `plan.state.updated`, `models.changed`, `channel.status_changed`, `channels.conversations_changed`, `im.tools_enabled`, `im.policy_changed`, `im.workspaces_invalidated`, `command_permission.requested` |
| **History** | `session.history` returns the full chat tree (entries + `leafEntryId`); clients replay branches client-side. `session.snapshot.get` returns history + tasks + plan state in one round-trip. `session.events.get` replays the per-session event log by `seq`. |
| **Dynamic tool loading** | Tools split into `always` (resident at attach) and `deferred` (loaded on demand via `addTools`). MCP servers, skill subagents, and other deferred sources populate the candidate pool. |
| **Project context instructions** | `CLAUDE.md` / `AGENTS.md` / `DESIGN.md` resolution from a priority chain, wrapped as `<instructions>` tags, prepended to every LLM call. Gated by `taco.json.instructions`. |
| **Subagent system** | Per-agent tool whitelist, depth-based recursion guard, `agentContinue` for resumption, dedicated child session via the `agent` tool, per-tool name namespace. |
| **Plan mode** | `planEnter` / `planExit` tools, plan docs persisted under `.taco/plans/<slug>.md`, hard-gate enforcement during execution. |
| **Tasks system** | `todoWrite` (ephemeral breakdown) + `taskCreate/Update/List` (persistent named lists), per-session task store, `tasks.updated` push. |
| **Memory system** | `~/.taco/memory/MEMORY.md` + per-topic files in `projects/<id>/<slug>.md`, hash-based optimistic concurrency, automatic extraction hook. |
| **Permission broker** | 5-level risk classification (readOnly / workspaceWrite / externalSideEffect / destructive / privilegeEscape), rule-based ask/allow/deny, scope (once / session / global), subagent inheritance, IM workspace policy overrides. |
| **IM channels** | Channel SDK framework; `channels.*` admin + `imPolicy.*` per-workspace overrides; `channel.status_changed` and `im.*` pushes. |
| **MCP** | stdio + Streamable HTTP transports, dynamic tool registration via `DeferredToolRegistry`, `mcp.listServers` health probe, `alwaysLoaded` resident set. |
| **Checkpoints** | Turn-scoped pre-write file snapshots; `checkpoints.list` / `checkpoints.restore` for client-driven undo. |
| **Config** | `taco.json` under `$TACO_HOME` (default `~/.taco/`); settings view masks secrets (API keys → `MaskedKey`; `mcpServers[i].{env,headers,command,args,url,cwd}` and `channels[i].config` are stripped). |
| **Desktop client** | Tauri 2 + React (`@taco-ai/desktop`); Node.js TUI example (`@taco-ai/protocol` shared types). |
| **i18n** | Desktop UI ships en + zh; `initialize.clientCapabilities.uiLocale` propagates to the per-turn `<reply_language>` tag. |

