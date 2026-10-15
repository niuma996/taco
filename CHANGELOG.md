# Changelog

All notable changes to Taco are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
starting with `v0.1.0` (the first open-source release).

## [0.2.10] — 2026-10-16

A one-line fix: the input box goes back to the bottom of the window, where
it belongs.

### Fixed

- The input box stays at the bottom of the window. Since 0.2.9 it scrolled
  along with the messages, which held it down only while the conversation
  was long enough to fill the pane; in a short conversation it floated
  right under the last message, halfway up the window.

## [0.2.9] — 2026-10-16

A subagent can now work inside your own Claude Code CLI, the agents that
give a subagent its job can be written from the desktop, and a session
that's still working no longer looks like it's done.

### Added

**A second runtime for subagents.** An agent marked `claude-code` hands
its work to the `claude` you already have installed and signed in to,
instead of running inside taco. You pick which tools it has and how it
asks permission, and you watch it work live in the panel.

**Agents you can edit from the desktop.** The agents panel can now create,
edit and delete agent definitions — no more hand-writing files — and a
saved change takes effect right away in every open workspace, without a
restart. An agent that is only a set of tools, with no personality of its
own, can now say so instead of being left with a blank prompt.

**Panels that open themselves.** When a turn spawns a subagent or starts a
task list, the task and subagent panels come up on their own, once per
run, so you don't have to go looking for them. Reopening a session that
was already running stays quiet.

### Changed

**One visual language.** The interface reads as a single design rather
than a stack of separately-built panels.

### Fixed

- A session that is still working no longer looks like it finished.
  Switching away mid-run and coming back, or starting a new chat while
  another session was busy, both marked the running session as stopped
  even though it carried on.
- The CLI stops instead of taking over another install's daemon. Launching
  taco while a live daemon from a different checkout or bundle was running
  used to quietly kill it, leaving you connected to an old build with
  nothing to explain it; it now says what's in the way and how to fix it.

## [0.2.8] — 2026-10-14

A reliability release: the agent stops being told about tools that don't
exist, stops deadlocking on its own compaction, and no longer walks
around the permission gate with a `~` in the path. Deleting a session now
takes its subagents with it.

### Added

**Global skills and agents from `write`.** From a local main session,
`write` now reaches `$TACO_HOME/skills/` and `$TACO_HOME/agents/`
directly, without a permission prompt — installing a skill no longer
requires an approved shell command.

### Changed

- Prompts no longer advertise capabilities the harness doesn't have: an
  `edit` parameter that isn't one, read-before-edit enforcement that
  doesn't exist, tools missing from the catalog, and tool calls described
  as sequential when they run concurrently.
- Subagents no longer receive `agent`, `askUser`, `planEnter` or
  `planExit`, so a child can't ask the user a question it has no way to
  deliver.
- The desktop shell is tidied into one system — panes now share surface
  tiers, heading alignment, and button and modal primitives.
- Pi moves `0.86.1` → `0.99.2`, the last release before Pi 1.0 relocates
  the agent harness out of `pi-agent-core`. The bundled OpenRouter catalog
  dropped 16 model ids, so a `defaultModel` pointing at one now starts
  with no default model.
- `session.delete` now emits one `session.deleted` frame per session id
  removed, not just the target.

### Fixed

- The permission gate no longer leaks `~`, `@` and `file://` paths:
  `write ~/.zshrc` passed the workspace-containment check because the path
  was compared before pi expanded it.
- Auto-compaction no longer deadlocks. Compaction scheduled from the
  idle-owner callback waited on the very lock it already held, so a session
  past its threshold hung instead of compacting.
- Stopping a shell command now stops what it started. Surviving
  grandchildren could hold stdout open and freeze the tool call forever;
  POSIX now signals the whole process group.
- Deleting a session takes its subagents with it: `session.delete`
  cascades across the session tree instead of orphaning each one's task
  store and results.

## [0.2.7] — 2026-09-23

Subagents become background citizens: they no longer block the turn, can be
stopped one at a time, and no longer lose their result to a restart.

### Added

**Background subagents.** A subagent keeps running after its tool call
returns and delivers its result when it finishes. The desktop panel gains a
Stop button that cancels a single background subagent, and a result now
survives a sidecar restart or a parent session that was never reopened in
time to catch the live notification.

### Changed

**Cheaper repeated turns.** Live context is now folded into the prompt in a
way that no longer invalidates the provider's prompt cache every turn.
Subagent cards also report the correct status in more cases — an interrupted
subagent shows as an error rather than quietly completing, and a finished one
no longer sticks on "running".

### Fixed

- Shell commands that catch or ignore `SIGTERM` no longer hang forever,
  including when the user cancels them.
- The `memory` skill stays available for the whole conversation instead of
  being dropped after its first use.
- A subagent that already succeeded is no longer overwritten with a spurious
  failure by a delivery hiccup.
- Session and subagent previews now open when using a custom `TACO_HOME`;
  they used to fail silently with no error message.

## [0.2.6] — 2026-09-20

Session titles become summaries rather than truncated first messages, and
two prompt-cache fixes cut the cost of long-lived sessions.

### Added

**LLM-derived session titles.** Titles carry their provenance — placeholder →
LLM summary → explicit rename — with the summary re-derived after each
completed run and pushed live through a new `session.renamed` event. A manual
rename is terminal and is no longer overwritten by a later summary. The title
bar also gains quick language and theme menus.

### Changed

Rust CI (clippy and `cargo test`) for the Tauri shell now runs on every PR
instead of only at release-tag time.

### Fixed

- Manual Compact is sized from current usage rather than the auto-compact
  budget, so a session far below the auto threshold no longer retains
  everything and produces an empty summary.
- Skill hot reload no longer rebuilds a byte-identical system prompt, so a
  no-op rescan no longer forces a KV-cache miss on every session attached
  afterward.

## [0.2.5] — 2026-09-19

Subagent runs stream live progress and become resumable, and compaction is
driven end-to-end from the sidecar lifecycle.

### Added

**Streamed subagent progress and a resumable child session.** A durable
recovery handle is published as soon as a subagent's child session exists, and
live turn updates fold into the running tool card — an interrupted
`agent` / `skill` call can resume via `agentContinue`, and the desktop can open
the child session mid-run. The context-usage ring also gains a Compact button
that triggers `session.compact` below the auto threshold.

### Changed

Compaction is owned directly by the sidecar lifecycle (pi 0.85 dropped the old
before/after hooks), derives its settings from the user's threshold for every
path, and collapses to a single LLM call. Subagent progress is read from
`turn_end` instead of re-reading the child's branch. Read-only git inspection
commands (`git blame`, `git rev-parse`, `git ls-files`, `git merge-base`,
`git describe`, and the read-only forms of dual-use verbs) are auto-allowed
for `explorer` / `reviewer`; mutating siblings still ask.

### Fixed

- Pinned skills survive compaction: `<skill_body:NAME>` was not balanced XML,
  so pin, TUI hide, and the reinjector could not see it — it is now emitted as
  an XML attribute with per-name dedupe.
- Subagent sessions no longer show up as top-level sessions in the chat list,
  which is now sorted by last user-visible message instead of file mtime, so
  upgrading no longer stamps every old session as "just now".
- Subagent panel messages no longer inherit the main-chat gutters.

## [0.2.4] — 2026-09-17

File preview becomes format-aware, and the Windows installer stops stomping a
running daemon.

### Added

**HTML in file preview.** The preview popup renders HTML inline and adds an
explicit "open in system viewer" affordance, so the path-to-browser round-trip
no longer requires leaving the app or hand-copying paths. The debug dock also
becomes draggable, and the subagent panel gains a message-meta row.

### Changed

Tool card layout is overridable per tool, so one tool's awkward region can be
reshaped without polluting the default for the others; the default summary
drops its JSON tail so cards read as prose first. Skill load, hot-reload, and
extension diagnostics now route through a single logging helper.

### Fixed

The Windows installer asks the running daemon to shut down before swapping the
`.exe`, so a long-running install no longer leaves a stale or partially
updated sidecar.

### Security

The updater bundle embeds the base64 of the whole `.pub` file rather than raw
bytes inline, so a tampered or truncated key fails the same way on every
platform instead of silently differing per architecture.

## [0.2.3] — 2026-09-16

Subagents get a first-class side panel, and the sidecar's derived state stops
being captured at construction time.

### Added

**Subagent side panel.** The right rail gains a subagent panel alongside the
Tasks / Files drawer, with the agent card as its entry point and a
drag-resizable width. The panel list derives straight from the message stream,
so it stays in sync without per-source invalidation plumbing. On the sidecar
side, unknown tools now reject absolute paths at the fence, and a request to
cancel compaction is no longer silently dropped.

### Changed

Long-lived consumers receive a `resolveX: () => X` thunk instead of a snapshot
of mutable config, with a name-comparison guard that keeps steady-state prompts
byte-identical. The sidecar's internal runtime is split by concern and every
"wait for an async capability" path goes through one `withDeadline`.
`WorkspaceId` / `SessionId` / `ToolCallId` are branded so passing the wrong ID
across a module boundary is a compile-time error. Right-rail exclusivity
collapses to a single state source.

### Fixed

- `SubagentPanel` is mounted inside `SubagentProvider`, so its context is
  stable; the drag handle keeps the rail width inside a moving bound.
- Push sequence numbers stay continuous across a sidecar restart, so
  reconnecting clients no longer see spurious gaps.
- Onboarding is gated on a settled flag rather than a transiently non-empty
  `cwd`.

## [0.2.2] — 2026-09-14

Mid-turn steering arrives on the wire, and scheduled jobs gain honest run
reporting.

### Added

**Steer and follow-up.** `session.steer` injects a message into a running
turn, `session.followUp` queues one to run after it ends, and
`session.cancelQueued` removes a queued follow-up. The wire protocol advances
to 2.1 and `session.steer` now returns `{ mode, entryId }` so a 2.0 daemon
cannot be misread as a successful enqueue. Scheduled jobs also gain run caps:
`max_runs` bounds accepted fires and `max_consecutive_failures` is a circuit
breaker that records its reason and detaches the timer.

### Changed

The workspace rebuilds its toolset at the start of every turn and merges the
result into the active session, so policy / IM / extension changes reach a
live conversation on its next message without invalidation plumbing.

### Fixed

- `runNow` / `runJob` return `JobRunResult { status, error }`; "ok" now means
  the fire was *accepted*, not that the turn completed.
- A job force-fired from inside its own IM conversation degrades to a queued
  follow-up instead of self-deadlocking on a busy lane.
- The session active-tool allowlist re-aligns on attach, with retryable
  candidates exempted.
- The `officecli` skill directory ships inside the desktop bundle.

## [0.2.1] — 2026-09-11

Two new built-in skills, manual sidecar restart, and a wider read-only
allowlist.

### Added

- **`officecli`** ships as a built-in extension that bundles the skill and
  allowlists its shell commands in memory, so Office-document workflows don't
  prompt on every call; disabling the extension drops both.
- **`taco-configure`** — an umbrella skill for remote skill install, agent
  authoring, and atomic patches to `$TACO_HOME/taco.json`.
- Manual sidecar restart from **Settings → App**, replacing
  `taco stop && taco start` when the daemon's reconnect ladder gives up.
- Decisions route through `askUser` instead of prose questions, and a denied
  command is no longer re-routed to the same outcome via another command.

### Changed

The read-only allowlist grows to cover the everyday shell toolbox — file
inspection, text search, hashing, and `find` with safe predicates. `find`
flags that write files or spawn commands still trip the ask gate.

### Fixed

- The Files drawer toggle stays visible on the new-chat splash, and images
  inside the drawer preview inline.
- `channels.list` and `channels.create` share the same view of configured
  instances.
- `{subagent_delegation}` markers no longer leak into the rendered system
  prompt.

## [0.2.0] — 2026-09-10

The sidecar moves to Pi 0.85.1 end-to-end and into the long-lived daemon
model, and the desktop becomes tray-resident.

### Added

- **Pi 0.85.1 migration.** Streaming output works again (the sidecar mirrors
  the new per-message payload back to the legacy field), a `toolResult` with
  `terminate: true` is a valid closing reply rather than a role mismatch, and
  a sidecar restart resumes an interrupted run while logging how it ended.
- **Daemon supervisor.** The `cli` package is promoted to a first-class entry
  point (`start` / `status` / `stop` / `install` / `uninstall` / `upgrade`);
  release builds attempt `taco install` on first launch to register a
  LaunchAgent (macOS) or Task Scheduler task (Windows).
- **Tray-resident desktop.** A system-tray entry, single-instance window, and
  the "Close hides to tray, Quit exits for real" lifecycle.
- A new-chat welcome experience on cold start, workspace switch, and sidecar
  restart, plus a "Chats" rename with unified row height, a task-panel toggle
  with an unfinished-task awareness dot, and the context indicator moved into
  the input row.

### Changed

Wire tool events are named `tool_start` / `tool_update` / `tool_end`, and
`LaneBusy` becomes a tagged error rather than a thrown `AgentHarnessError`.
`CreateSessionResult.assistantMessage` widens to `AgentMessage`. README gains a
first-launch section for the unsigned macOS / Windows binaries, and the
`pnpm release-age` gate is restored for the Pi upgrade.

### Fixed

- Subagent depth is read from `session.facts` instead of a `cwdDepth` path
  heuristic, eliminating silent misrouting on forks.
- History rows are no longer stamped with the load time, so the sidebar shows
  the real last-activity timestamp.
- A prompt with no reply surfaces the real reason — model unavailable, hook
  decline, or abort.
- `one-shot` session handles close on completion, leaving no socket keepalive
  or zombie child processes.
- The scheduler no longer overwrites a user's `imRouting` forward routing when
  attaching a pin session.

### Removed

Five dead exports removed from the sidecar; the one retained export is
documented via `@internal` JSDoc and tracked by `knip`.

## [0.1.3] — 2026-09-04

Mermaid rendering, a WeCom channel, and an LLM dump switch.

### Added

- Mermaid fenced code blocks render as diagrams by default, with a header
  toggle to flip back to source.
- A WeCom aibot channel with a credential bind flow and a hardened reconnect
  lifecycle.
- An `llmDumpToFile` switch in the Debug tab that tees `[taco:llm]` lines to
  `$TACO_HOME/logs/llm-dump.log`.
- Plan-mode directives and the explorer subagent nudge models to emit
  `flowchart` / `sequenceDiagram` blocks for complex traces.

### Changed

The code-block language tag survives end-to-end through shiki via a
transformer, and `settings.write` fans out to every `SidecarServer` in the
daemon so updates reach the live child without a restart.

### Fixed

A stale-code daemon is reaped instead of reused, detected by a ping/pong
`sidecar_version` check, and the NSIS installer's preinstall hook kills any
leftover sidecar daemon before an upgrade.

## [0.1.2] — 2026-09-01

Fork-context subagents and config changes that apply without a restart.

### Added

- A `context: fork` subagent capability with frontmatter-driven hints.
- Agent tool hints derived from `AgentDefinition`; the reviewer builtin ships
  with `context: fork`.

### Changed

`AgentSpawner.prepareChildAttach()` is shared between the spawn and resume
paths, and the test suite is reorganized (dedupe and logger merged, checkpoint
store and manager merged, stale cases dropped).

### Fixed

- `mcp.*` mutations apply without a sidecar restart.
- A subagent's `parentInstructionsBlock` snapshot is replaced with a lazy
  thunk.
- `stderrTee` error listeners are removed on dispose.

## [0.1.1] — 2026-08-27

The first post-open-source releases: daemon mode, the scheduler, and desktop
auto-update.

### Added

- **Daemon mode** under launchd / schtasks, with a CLI `upgrade` command.
- **Scheduler and jobs**, with a Schedules UI in the desktop client.
- IM messages routed through pinned sessions.
- `sidecar.pid` upgraded to JSON, with reaping that honors the install id.
- Desktop auto-update via `tauri-plugin-updater`.

### Changed

- Chat UI polish: inline code, message outlines, a persisted sidebar.
- Desktop startup hardening: TCC prewarming, `EPERM` tolerated, a packaged CSP
  that allows WASM, a persisted workspace list.
- Sidecar reliability: cached login-shell `PATH`, Windows `atomicWrite` that
  tolerates `EPERM`, version-stamped outbound requests.
- Cross-platform stability: LF endings repo-wide and a pnpm lockfile stable
  across macOS and Windows.
- A scheduler and shared-layer refactor unifying RPC naming and hardening the
  job lifecycle; the debug daemon's `$TACO_HOME` is isolated from the shared
  install.

### Fixed

- Repeated "sidecar hello timeout" on `tauri:dev`, and the slow-start
  kill-restart loop.
- The reap path distinguishes own vs. foreign daemons, scopes wedged-daemon
  kills, and handles dev-mode launcher semantics.
- Windows onboarding, runtime, and window chrome; packaged binaries no longer
  pop a console window.
- Agent tool cards orphaned by process exit are cleaned up.

## [0.1.0] — 2026-08-13

First open-source release. The sidecar has been in active use for several
months; this is the version cut for the public release.

### Added — protocol

Initial wire contract: mandatory `initialize` handshake (v1.0) plus 54 RPC
methods across 14 namespaces and 20 push frames.

### Added — runtime

Initial runtime: multi-workspace / multi-session routing, dynamic tool
loading, subagents, plan mode, tasks, memory, permission broker, IM channels,
MCP integration, checkpoints, project context instructions, and IM workspace
policy.

### Added — clients

Initial clients: `@taco-ai/protocol`, `@taco-ai/shared`,
`@taco-ai/debug-console`, `@taco-ai/desktop` (Tauri 2 + React), and the
`examples/python-cli/` and `examples/node-tui/` examples.

### Added — infrastructure

Initial infrastructure: `$TACO_HOME` storage layout, `docs/` set (including
the auto-generated protocol doc), MIT-licensed npm packages
`@taco-ai/{protocol,shared,sidecar}`, and en + zh i18n in the desktop client.

### Security

Initial safe-config view, channel credential isolation, IM workspace FS tool
isolation, and per-cwd Tauri FS scoping.