# Changelog

All notable changes to Taco are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
starting with `v0.1.0` (the first open-source release).

## [0.4.0] — 2026-11-14

A release about seeing everything at once and letting work survive: workspace
and IM conversations share one sidebar, agents and skills show where they came
from, and scheduled or inbound work waits in a queue that survives a restart.
Child agents can keep talking, and Codex joins Claude Code as a supported
runtime.

### Added

**One sidebar for every conversation.** Workspace chats and IM conversations now
appear together. You can browse and search across workspaces, keep a group open,
and see which conversations are busy, which have unread messages and which are
waiting for you — without switching workspaces one by one.

**Agents and skills show where they come from.** The Agents and Skills panes
distinguish the effective definition from the global, workspace and builtin
ones. A definition another layer hides can still be read, and you can edit
Taco's global and workspace agents without leaving the chat you are in.

**Every conversation keeps its own memory.** An IM conversation has its own
topic memory, reads the memory of the workspace it belongs to, and can opt into
the memory of other local workspaces the sidecar is running. Inherited topics
are read-only, and a memory reference fetches the full text without opening any
extra files.

**Scheduled and inbound work waits in a durable queue.** Incoming IM messages
and scheduled jobs are written down before they run. Order is kept per
conversation, a restart picks up the operation that was already accepted, and
the Work pane shows how each one ran and whether it reached its destination.

**Child agents keep talking.** `chatToAgent` gives a child more context or a
follow-up task, and `listAgentSessions` lists the children and siblings it may
address. The receipt says whether the message was accepted or finished, and the
answer still goes back to the parent that started the work.

**Claude Code and Codex children can be resumed.** Claude Code children keep
their native session and accept later messages; a message that arrives while
the child is busy is delivered on the next turn instead of interrupting the
tool it is running. Codex agents use the official SDK, install from the Agents
page, and resume their own thread.

**External agents can talk back.** Claude Code and Codex receive the permitted
`chatToAgent` and `listAgentSessions` tools for each run. Taco decides who the
sender is and which conversations it may address.

**Plan mode lets you approve a single write.** A file write outside the plan
document — but still inside the workspace or an associated directory — can be
approved on its own without leaving plan mode. The approval covers that path
for the current plan; shell writes stay blocked.

### Changed

**Reconnecting keeps the conversation intact.** A reconnect restores the partial
reply, the running tools, queued input, pending approvals and child
conversations. Progress stays on the original agent card, and the panel
reconciles live updates with the full history.

**More fits on screen at a glance.** Agent and plugin panes use a wider layout,
catalogs share the same controls and headings, markdown tables are rounded, and
message details — timestamps among them — appear on hover instead of crowding
the message.

**The assistant is told what it can actually do.** Prompts explain how to find a
child, what a receipt means, which siblings are reachable, and that later
context has to be sent explicitly. Saved memory and project context can no
longer grant a new approval through an embedded control tag.

**Files and queues are written once.** Task lists and results are published
atomically, so a crash cannot leave half a file behind, and the scheduler only
reads the entries that are still open.

### Fixed

**Switching conversations no longer gets stuck.** An outdated new-chat request
no longer cancels the conversation you picked afterwards. Restored groups load
their conversations, and panels that belong to the chat close when you leave
it.

**Editing an agent keeps its definition.** Custom file names and hidden global
definitions stay readable and editable, and unchanged working directories and
Codex tool restrictions survive a save.

**Stopping and replaying work respects the right run.** A cancellation that was
deferred still takes effect after a restart, a replayed batch keeps its own
waiting question, and a session that triggers its own scheduled job returns
right away instead of waiting for itself.

**Receipts say what really happened.** Follow-up messages that a turn limit
dropped are no longer reported as finished, messages handled together do not
start a second continuation, and shutting down settles the open receipts before
clearing the execution state.

**A failed answer keeps plan mode on.** Work that was cancelled or expired, a
busy conversation, or a receipt that could not be saved will not approve the
plan by accident, and a retry stays tied to the plan you reviewed.

**Opening a local file or folder works again.** The action that opens the
workspace folder or a session log in the browser now opens the path instead of
doing nothing.

### Breaking changes

- The protocol moved from 2.13 to 2.18. The new desktop needs matching support
  for scoped catalogs, layered memory and `memory.read`; older clients keep
  receiving capability-based projections for inbound Work and the memory layers.
  Keep the desktop and the sidecar on the same release line.
- `agentContinue` is gone. Use `chatToAgent` both for a message to a running
  child and for a follow-up after it finished. Existing history stays readable,
  but old calls appear as plain tool records and take no part in the agent
  topology or in recovering a run. An interrupted legacy call is not resumed
  automatically.

### Upgrade notes

- Upgrade the desktop and the sidecar together; a running daemon may need a
  restart to pick up the new protocol and runtime code.
- Codex agents use the provider, model and credentials from your own Codex
  configuration under `$CODEX_HOME` (default `~/.codex`). Leave the model empty
  to inherit it, and a custom provider with its own credentials needs no OpenAI
  login. Claude Code still needs its own CLI and Agent SDK; the in-app
  installation card applies to Codex only.
- Native Claude Code and Codex sessions are stored apart from the conversation
  history Taco shows. Native storage supports resuming, but it does not mean
  the session appears in the original application's conversation list. Older
  Claude Code history without a native session cannot be resumed.
- IM topic memory is now per conversation. Topics stored under the earlier
  shared identity are not copied over automatically — review them before moving
  any notes. The hand-written `MEMORY.md` stays shared, and associated and
  system topics are inherited read-only.
- Delivery to an IM platform is still at-least-once. A child message that was
  interrupted and cannot be confirmed is not resent, and old inbox batches
  that were still dispatching without a Work handoff are not replayed, because
  their earlier outcome is unknown.

## [0.3.9] — 2026-11-09

A release about background work that can wait for you: a scheduled job or a
background agent that needs an answer now says so, can be stopped, and no
longer gets lost when the connection drops. The chat also grew a memory of
its own — every conversation keeps its own draft, its own state and its own
attachments.

### Added

**Background work can wait for you.** A scheduled job or a background agent
that pauses for an answer or a command approval shows as "waiting" in the Work
pane, together with what it is waiting on. Running and waiting tasks can be
stopped there, and finished records can be deleted.

**Sending an answer twice is safe.** A lost response or a restart no longer
loses your answer; resubmitting the same answer continues the same run
instead of repeating it.

**Each chat keeps its own draft.** Text, attachments and the chosen model are
remembered per chat, and a message that may not have been delivered can be
pulled back into the input box.

**Notifications stay with the account that started the work.** A finished
background task is still delivered after a token refresh, but switching
accounts no longer sends the old notification to the new one.

**Stopped agents keep what they found.** A subagent that is cancelled or times
out returns the partial results it had already produced.

### Changed

**The composer tells you where the conversation stands.** Sync pending, run
state unconfirmed and partially shown history are surfaced under the input
box, and "open chat" reaches the conversation that is actually waiting on you.

**Waiting questions expire on their own.** A question left unanswered for
seven days is closed and kept as a record; late answers are refused instead of
reviving a dead run.

**IM channels got friendlier.** The assistant asks its question in the reply
instead of raising an error it cannot show, re-binding a WeChat account can be
cancelled instead of hanging on the QR login, and an explicit request for a
reply language now wins over the configured one.

**The assistant converges instead of over-checking.** Project instructions,
skills and memories can no longer override the core rules, and a scoped task
is no longer widened into an open-ended investigation.

### Fixed

**Switching chats no longer mixes them up.** Late responses from a previous
chat are discarded, state is kept per chat, history that fails to load is
reported instead of rendered as an empty conversation, and merging history
with live updates no longer loses or duplicates messages.

**Answers and attachments survive a failure.** An answer that fails to submit
keeps its question card so you can send it again, and pasted image previews
and the model choice no longer break when you switch chats.

**Stopping no longer kills the next run.** A stop request is matched to the run
it was meant for, text dropped by a stop returns to the chat that asked for
it, and approvals from before a restart are not offered again.

**Work bookkeeping is more accurate.** A late result from an earlier attempt
can no longer overwrite a run that is still waiting, work records recover
after a crash instead of being marked failed, and deleting a chat marks the
work attached to it as interrupted rather than leaving it "running" forever.

**Unbound channels and IM routing behave.** Cleared credentials are honoured
even if a default remains in the config file, and work started on an IM
channel finds the right conversation.

### Breaking changes

- The protocol moved to 2.13 and Work gained a "waiting" status. Clients that
  do not announce `workWaiting` keep receiving `running`, so older desktops
  keep working. `work.cancel` and `work.delete` are new RPC methods; a
  sidecar that predates them answers `unsupported`. Keep the desktop and the
  sidecar on the same release line.
- The work store does not downgrade: a daemon older than 2.11 cannot read the
  new work records, so rolling back needs a matching backup.
- One question, one answer. Resubmitting a *different* answer for a question
  that was already answered is refused with `invalid_state`, and a question
  left for seven days or cancelled with its work no longer accepts an answer.

### Upgrade notes

- The desktop and the sidecar should be upgraded together. The Work pane's
  stop and delete actions, and the "waiting" status, need a sidecar from this
  release.
- Deliveries are still at-least-once. Deleting a work record does not recall a
  message the platform already accepted, and a new account will not receive
  an old notification.

## [0.3.8] — 2026-11-07

A patch about giving the agent a bit more room to work: file edits can be
rolled back, a separate model can take over the small background jobs, and the
memory behind them is a little more structured.

### Added

**Edits can be rolled back.** Checkpoints are grouped by the chat that created
them, and a reply that changed files offers a one-click undo; files changed
again afterwards are skipped rather than overwritten.

**An auxiliary model for the small jobs.** Session titles and memory extraction
can run on a separate, cheaper model with its own reasoning level. When it is
unset or fails, the session's own model takes over.

**Memories carry a bit more context.** A memory body can hold one durable theme
instead of a single sentence, an entry can show which conversations it came
from, and the assistant can page back through an earlier conversation to check.

**Memory upkeep settings live in the Memory pane.** The consolidation
thresholds moved next to the memory list, and archived memories can be purged
after a retention window.

### Changed

**Automatic memory extraction is more selective.** It writes only what it can
point at, skips a conversation it already saw, and backs off instead of
retrying on a timer.

**The list panes read as cards.** Agents, Tools, Skills and Memory show a card
per entry with its description and tags, and the Tools filters are one-click
chips.

**The app is easier to drive from the keyboard.** The chat list moves with the
arrow keys, inputs keep a visible focus ring, approval choices are four
clearly separated buttons with "Always allow" highlighted, and the whole chat
row is clickable.

**Permanent deletions are guarded.** Every destructive confirmation uses a
danger-styled button and opens with focus on Cancel, so a reflexive Enter no
longer destroys anything.

**Secondary text is easier to read.** It now meets WCAG AA contrast in both
themes, and the smallest labels are no longer microscopic.

### Fixed

**In-app updates work on macOS again.** The update archive is now packaged in
the format the updater expects, and the release pipeline verifies it before
publishing.

**Subagent replies no longer leak into your IM channel.** A background agent's
output returns to its parent chat, which decides what (if anything) to send
you.

**Stopping a task now really stops the background agent.** Cancelling while
the agent is still starting no longer lets a model run start anyway.

**A shell command that ignores the stop signal no longer hangs.** Its whole
process group is terminated, so leftover background children cannot keep the
command running.

**Archived memories are cleaned up on schedule.** Memories archived by earlier
versions now expire based on when they were first created.

### Breaking changes

- Memory consolidation and memory entries changed shape: the scheduled job's
  `minChanges` and `model` arguments are ignored, consolidation now runs on
  the default model, a memory is a topic rather than a sentence, and the
  length limit moved from 1000 to 2000 characters. Existing files stay
  readable.
- Restoring a checkpoint now requires that chat to be open; the other groups
  offer "Open chat" instead.
- The protocol surface grew a little: `checkpoints.restore` now returns a
  `conflicts` array, `memory.list` entries carry the optional `sources`,
  `explicitlyRequested` and `archivedAt` fields, and a `memory.changed` push
  event was added. Keep the desktop and the sidecar on the same release line.

### Upgrade notes

- Memory consolidation now runs on your default model. If you had a dedicated
  consolidation model configured, point it at the auxiliary model setting
  instead.
- macOS in-app updates install properly now. The 0.3.7 updater archive was
  broken, so if 0.3.7 never offered you an update, update once by hand.
- `taco.json` gains two optional keys, `liteModel` and `liteThinkingLevel`,
  for the auxiliary model. Existing config files need no change.

## [0.3.7] — 2026-11-04

A patch on top of v0.3.6: a channel that cannot start because its dependency is
missing can now be repaired from the app, the desktop no longer races itself
into starting several daemons, and the agent runtime moves to the Pi 1.5 model
stack.

### Added

**A missing channel dependency can be installed from the app.** When a WeChat
or WeCom channel fails to start because its optional SDK is not installed, the
failed card in the Channels pane now offers "Install dependency and retry". One
click installs the dependency and retries the channel; a dependency that is
already installed can be retried without installing anything.

### Changed

**The agent runtime moves to the Pi 1.5 model stack.** New models and upstream
provider and auth fixes now arrive by bumping the dependency, and model calls
can be recorded as spans and metrics through the harness telemetry API.

### Fixed

**Concurrent workspace opens no longer start several daemons.** The desktop app
keeps a single owner across the whole startup sequence, so parallel opens can no
longer race into competing daemons.

**A daemon that loses the startup race no longer removes the winner's socket.**
The sidecar now confirms who owns the control socket before reusing it, and
never unlinks a live one.

### Upgrade notes

- The Channels pane can install the optional channel dependency for you. You no
  longer need to open a terminal to install the WeChat or WeCom SDK by hand —
  the app does it, and retries the channel straight away.
- The published sidecar now pulls the Pi harness from npm instead of a local
  tarball. Nothing to do on your side; the dependency arrives with the install.
- Everything else in 0.3.7 is the same as 0.3.6.

## [0.3.6] — 2026-11-04

A patch on top of v0.3.5: the sidecar no longer refuses to start on a machine
that does not have the optional channel SDKs installed.

### Fixed

- The sidecar starts without the optional channel SDKs. The WeChat and WeCom
  SDKs are now loaded on demand, so a machine that never installed them runs
  the sidecar as usual, and only hears about the missing SDK when it actually
  creates that channel.

### Upgrade notes

- If you installed 0.3.5, please move to 0.3.6. The sidecar in 0.3.5 loaded
  the optional channel SDKs while starting up, so it could refuse to start at
  all on a machine without them. The desktop app shipped the same sidecar, so
  the desktop build needs the update too.
- Everything else in 0.3.6 is the same as 0.3.5.

## [0.3.5] — 2026-11-04

A release about keeping score of the work that happens while you are not
looking: background runs and scheduled fires are now recorded, visible, and
delivered.

### Added

**A "Background work" pane.** Background subagents and scheduled fires are
recorded, and the new pane shows what is running, what needs attention, and
what has finished. A row can open the conversation that started the work, and
a notice that was never delivered can be sent again.

**A run history for every schedule.** Each schedule opens a History dialog
with its recent runs — when they ran, how long they took, how they ended, and
the answer they produced.

**Background answers reach your chat reliably.** The result is kept with the
record and delivered to your channel with retries, and a daemon restart in the
middle of a delivery picks up where it left off.

**A read-only `ls` with a path pattern no longer asks for approval.** In a
local automatic session with no deny rules, `ls src/*` simply runs.

**MCP servers load on demand.** A workspace no longer waits for every MCP
server to connect at startup, and adding or removing one no longer asks for a
restart.

**Background runs get a time limit and a heads-up.** An agent profile can set
a timeout in minutes, the agent is told when it is close to that limit, and a
timeout reads differently from a stop you asked for.

**A read-only subagent cannot write files.** The tools an agent profile
declares are now a hard boundary, and a read-only agent is told up front that
it cannot write.

### Changed

- The right panel takes a share of the chat area — 30% by default, never more
  than half — instead of a fixed width, so it behaves the same on a wide
  display and a narrow one.
- A scheduled fire is recorded, and settles honestly: a prompt that joined a
  turn already running is reported as merged, and a run you stopped is
  reported as stopped rather than failed.
- The schedules list is one line per schedule, with icon actions, a "last run"
  column, and a warning when a schedule retired itself after too many runs or
  too many failures.
- MCP servers are shared where it is safe: HTTP servers are shared between
  workspaces, while each IM workspace keeps its own MCP connection private.
- The desktop follows the system's "reduce motion" setting, and panel opens,
  height collapses and icon swaps are now animated.

### Fixed

- A failed background subagent shows as failed and keeps its session, so the
  history stays reachable.
- A schedule's run history survives a restart, and a run that hangs can no
  longer lock the schedule forever.
- The panel width transition no longer lags: dragging, resizing and the
  keyboard all move it at the same speed.
- The screen reader announces the panel's real range, and the schedule actions
  stay in view.

### Breaking changes

- The wire protocol advances 2.7 → 2.10. The desktop refuses an older daemon,
  so keep the desktop and the sidecar on the same release line. The new
  surface is `work.list`, `work.get` and `work.retryDelivery`, plus a
  `work.changed` push.
- `mcp.createConfig`, `updateConfig` and `deleteConfig` return
  `requiresRestart: false`; it used to be `true`.
- `agents.write` accepts `timeoutMinutes` (1–600) and `maxTurns` up to 500
  (was 200). `agents.list` and `agents.read` return `timeoutMinutes`.
- Read `WorkSummary.sessionId`; `parentSessionId` remains as a deprecated
  alias.
- `jobs.history` reports a fire that is still going, not only finished ones.
- `@taco-ai/protocol` exports `THINKING_LEVELS`, `CUSTOM_PROVIDER_APIS` and
  `MCP_TRANSPORT_KINDS` as public constants; the values they hold are
  unchanged.

## [0.3.4] — 2026-10-31

A release about finding things again: the sidebar can now search every session
in a workspace, and the file-tool policy is decided in one place.

### Added

**Search your sessions.** The sidebar searches the whole workspace, not just the
page you have loaded. It also gained its own new-chat button.

### Changed

- Pending command approvals open next to the notification bell instead of
  covering the chat, and resolving one keeps the panel open while the rest are
  queued.

### Fixed

- A toolset change reaches every open session: an MCP server or a skill added
  mid-conversation now shows up in all of them.
- Tools no longer disappear mid-turn: a tool the model loaded on demand stays
  available.
- Chat sessions respect the file-tool policy: a session that denies file tools
  no longer loads them, and the model is told which tools are unavailable.

### Breaking changes

- The wire protocol advances 2.6 → 2.7. `session.list` takes an optional
  `query`. Keep the desktop and the sidecar on the same release line; a newer
  desktop refuses an older daemon at startup.
- `@taco-ai/shared` breaks: every typed client method takes a single params
  object now. `client.sessionPrompt(workspace, sessionId, text)` becomes
  `client.sessionPrompt({ workspace, sessionId, text })`.

## [0.3.3] — 2026-10-30

A release about the agent learning to see: you can hand it any file, it can read
a PDF, look at a picture, and answer a question about the photo you sent it
from a chat app.

### Added

**Attach any file.** The desktop attaches any file type now, up to 8 per
message and 25 MB each.

**PDFs the agent can read.** `read` extracts the text layer of a PDF, and
renders the first 5 pages of a scan as images. Four on-demand tools —
`pdfMerge`, `pdfSplit`, `pdfFill` and `pdfFields` — merge, split, fill and
inspect PDF forms.

**Images the model can see.** Pictures returned by MCP tools are forwarded to
the model, and a model you added yourself can declare image input.

**Photos sent from chat apps.** Pictures and files from WeChat and WeCom reach
the model now. A photo and its caption arrive as one message, not two.

### Changed

- A command approval requested from a chat app is refused right away instead
  of hanging, and the model tells you what it wanted to do.
- RPC parameters are validated, and a rejected request reports which field was
  wrong.
- The desktop asks for confirmation before deleting an MCP server, a permission
  rule or a scheduled task. Screen readers hear errors that were previously
  silent.

### Fixed

- Changing the memory switch, the system prompt or the MCP server list no
  longer interrupts the sessions that are running.
- A stale config lock no longer makes every settings save time out.
- The daemon error log is capped and rotates, and the push log no longer
  stalls the app.
- Restarting the sidecar from inside the desktop app lets it connect again on
  its own, and attachment thumbnails render.
- A tool installed after a session was created is available in that session.
  The shell tool no longer reaches for here-documents, which always needed
  approval.

### Breaking changes

- The wire protocol advances 2.4 → 2.6. Keep the desktop and the sidecar on
  the same release line; a newer desktop refuses an older daemon at startup.

## [0.3.2] — 2026-10-26

A release about memory that stops growing: a nightly job consolidates what the
agent learned, the model can search the questions you asked before, and a
session that used to take a minute to open now opens in a second.

### Added

**Memory consolidation.** A built-in nightly job proposes merges, rewrites and
archives per workspace in one model call. The first plan for a workspace is
always a preview — nothing is written until you apply it — and every run can be
undone. The memory pane became its review surface: the plan, the run history
and the archived entries, with archived topics restorable from there.

**Cross-session search tools.** `sessionSearch` and `sessionList` are deferred
tools that let the model answer "have I asked about this before?" from the
questions you typed in past sessions of the same workspace.

**A guide through your own messages.** The chat pane grew a rail of markers,
one per message you sent: hover for a preview, click to jump, and the arrow
keys, Home and End move between them.

### Changed

- The wire protocol advances 2.3 → 2.4 for the `memory.dream*` and
  `memory.restoreTopic` RPCs, the `dream` / `dreamScheduled` fields on
  `memory.list`, and `Job.builtin` on `jobs.*`. A 2.4 client refuses a 2.3
  daemon at handshake, so keep the desktop and the sidecar on the same
  release line.
- Opening a long session no longer stalls the main thread: only the last ~40
  messages render, the highlighters are preloaded, and a skeleton holds the
  place while the history loads.
- A user-added model inherits the provider's reasoning flag, output cap,
  compat and thinking-level map. `CustomModelEntry.reasoning` overrides it.
- The desktop renders Mermaid diagrams with `pele` instead of `mermaid`,
  which drops mermaid and its 109 transitive packages and shrinks the lazily
  loaded chart chunk from ~1.6 MB to ~250 kB gzip.

### Fixed

- Memory is extracted once per run. Extraction used to fire on every
  `turn_end`, so a 30-tool-call run extracted 30 times over the same
  transcript and injected ~18 KB of duplicated topics per call.
- Sidecar pushes arrive once. Concurrent `start()` calls each subscribed,
  so every push and every RPC response was parsed and dispatched twice.

## [0.3.1] — 2026-10-23

A release about how far the agent may reach: a workspace can be granted
extra directories, the agent can change your config once you approve, and
a third-party conversation can no longer read your disk.

### Added

**Associated directories.** A workspace — or an IM channel — can be granted
extra absolute paths, and the shell, the write tools and the agent editor
may act inside them. MCP servers, extension tools and subagent tools stay
anchored to the workspace's own root.

**Config changes behind your approval.** Two deferred tools read and patch
the global config, and every patch goes through the approval prompt before
it is written. API keys are never handed to the model.

**Project-scoped agents.** The agent editor can write
`<workspace>/.taco/agents`, where a definition shadows a global one of the
same name, and a `claude-code` agent can pin its own run directory.

### Changed

- The wire protocol advances 2.2 → 2.3 for the `workspace.associations.*`
  and `config.patch` RPCs. A 2.3 client refuses a 2.2 daemon at handshake,
  so keep the desktop and the sidecar on the same release line.
- The system prompt carries an `<environment>` block, and every injected
  tag names its origin, so a system event cannot pass for your approval.
- A model's context window can be declared in the provider panel; it used
  to be overwritten with the server default on every save.

### Fixed

- An IM conversation can no longer read files outside its own directory —
  `read`, `grep` and `glob` used to be exempt from the path fence.
- Stopping the first turn no longer deletes the new conversation.
- Opening a subagent's history no longer fails with "Session is already
  open": handle access is now serialized per session id.
- A session whose model was dropped from the catalog switches to a live
  model, preferring one on the same provider.

## [0.3.0] — 2026-10-20

A release about knowing what the agent is about to do: shell approvals are
decided from the parsed command instead of its text, the approvals waiting on
you are visible from anywhere in the app, and provider settings — key,
endpoint, model list — live in one place with a test that exercises the path
a session really uses.

### Added

**Approvals that read the command, not the string.** The sidecar parses bash
and PowerShell before it decides whether a command may run, so a quoted
metacharacter, a `sudo` prefix, a `find -exec`, a combined container option
or a benign `git -c` no longer slips past a rule meant to catch it.
`commandPermissions` grows separate `allow` and `deny` lists and an
`allowedDirectories` field, and the shell grammars ship inside the sidecar
and desktop bundles.

**Approvals you can find.** An always-visible button lists the approvals
every workspace is holding, a modal shows the command and the reason behind
each one, and the sidecar denies the whole batch as soon as no client can
answer instead of waiting on a request that would never arrive. IM approval
requests surface the same way.

**One control per IM policy field.** The parent layer's value is tagged with
that layer's name, so a single dropdown can say what it inherited and what
you are overriding. The two working-directory fields collapse into one
`shared` / `per-chat` / `custom` picker.

**Provider settings in one panel, with a connection test.** Built-in and
custom providers share one card and one editor. The test sends one minimal
chat turn through the same path a session uses, so a pass means the key, the
endpoint, the protocol and the model id all work together — many relays
answer `/models` while refusing chat, or the other way round. Failures are
classified so the panel can name the fix, and a saved key can be revealed in
place while staying masked by default.

### Changed

- The harness runtime now lives in `@taco-ai/pi-harness`. Pi 1.0 removed
  `AgentHarness` from `pi-agent-core` and left no stable replacement, so the
  surface moved into a package this project publishes itself; `pi-ai` moves
  from 0.99.2 to 1.3.0. The on-disk session format is unchanged.
- The wire protocol advances 2.1 → 2.2. `provider.listModels` takes
  `{ providerId }`, `settings.write` carries `providerExtraModels` /
  `providerHiddenModels`, and `providers.revealKey` is new. A 2.2 client
  refuses a 2.1 daemon at handshake — a 2.1 daemon answers `settings.write`
  with `ok` while dropping those fields, so model-list edits were being lost
  silently. Keep the desktop and the sidecar on the same release line.
- `auto` mode approves more than it used to. It used to auto-pass strictly
  read-only commands only, and anything that could change the workspace asked
  first; the decision now comes from the parsed command, and what always asks
  is a built-in floor — privilege escape, destructive commands, external side
  effects. Everything else passes without a prompt in `auto` mode.
- An IM policy file written by 0.2.10 or earlier migrates to `ask` the first time
  it is loaded, because `auto` in an IM policy now allows every command outside
  the deny lists and reading an old file verbatim would have widened it
  silently. The working directory is one field now: `binding` and
  `perChatScratch` are replaced by `executionDir`, and the old fields are
  still read from existing files.
- Tool results are capped by size before they enter the session, and grep
  caps by bytes rather than by line count, so one verbose command can no
  longer push a whole conversation past the model's context window.

### Fixed

- A default model that stops resolving no longer bricks the workspace. When
  the catalog moved under it, construction returned nothing — every
  `session.create` failed with "no model configured" pointing at the wrong
  thing — while the hot-reload path kept the previous value and looked fine
  until the next restart. Both now fall back to the first catalog model, and
  deleting the default provider clears the default instead of leaving it
  dangling.
- An IM channel that lost its network connection reconnects on its own
  instead of waiting for the app.
- A failed subagent now reports how far it got and whether it can be resumed.
- The edit card renders from the harness's unified patch, so the line numbers
  on it are real.

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