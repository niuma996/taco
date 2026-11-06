# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Tauri 2 desktop shell rendering a React/Vite web UI; the design language is web, wrapped in a native window.)

## Users

Developers and power users who run AI coding agents and want a workbench for driving them. Two usage modes are both first-class:

- **Coding & development tasks** — running agents inside workspaces, watching tool calls, managing sessions and checkpoints.
- **Standing personal assistant** — IM channels for remote driving, scheduled jobs, long-term memory; the desktop is the configuration and monitoring center for that always-on assistant.

## Product Purpose

Taco is a minimal sidecar protocol layer plus multi-client desktop workbench built on Pi's AgentHarness. It exposes an NDJSON-over-stdio JSON-RPC surface so any client, in any language, can drive multi-workspace, multi-session agent conversations. The desktop client is the primary visual surface for that runtime. Success means a power user can supervise several agent sessions across workspaces — and drive the same runtime remotely through IM — without losing track of state, cost, or pending approvals.

## Positioning

A protocol-first agent runtime: the sidecar is the product, and clients are interchangeable surfaces over an open NDJSON/JSON-RPC wire. Neighboring products ship a closed IDE or a chat app; Taco ships the runtime, the protocol contract (`@taco-ai/protocol`), and a desktop workbench on top — extensibility lands in an extension system rather than the core.

## Operating Context

- One long-lived daemon serves many open workspaces, routed by `cwd`; the desktop attaches to it.
- Sessions, history, and event logs are append-only JSONL — replayable, no migrations.
- Agents act through a tool surface (agent subagents, skills, plan mode, prompt tags) that the UI must make legible while a turn runs.
- IM channels (Telegram-style) let users drive sessions remotely; desktop binds and monitors those channels.
- Scheduled jobs and memory consolidation run unattended; the desktop surfaces their results after the fact.

## Capabilities and Constraints

Confirmed functionality: multi-workspace/multi-session chat, streaming tool-call cards, checkpoints, memory pane with consolidation, channels/IM binding and per-workspace IM policy, scheduled jobs, skills and plugins panes, subagent monitoring, pending approvals, command-permission modes, attachments, file tree/preview, update flow.

Technical constraints that future design work must respect:

- All colors, spacing, radius, and typography come from `src/styles/theme.css` tokens; both dark and light themes are first-class and must keep readable contrast.
- Shared primitives live in `src/components/ui/` with base styles in `src/styles/ui.css`; business views never re-implement primitives. Native `<select>` is forbidden — Radix-backed `ui/Select` instead.
- Keyboard navigation and `:focus-visible` rings are required on lists, tables, and inputs.
- Tauri on macOS renders in WKWebView with no CDP; automated visual inspection of the running app is not available, so design review is source-based.

## Brand Commitments

- Keep the name **Taco** and the existing logo (`assets/taco.png`).
- Continue the existing dark/light dual-theme token system as the asset all visual evolution builds on.

## Evidence on Hand

Real, shipping surfaces: ChatPane, WorkPane, MemoryPane, ChannelsPane, AgentsPane, SkillsPane, ToolsPane, CheckpointsPane, PluginsPane, SettingsPane, onboarding flow, plus the sidecar/CLI packages. There is no marketing site, no testimonial or benchmark content in the repo — future work must not fabricate any.

## Product Principles

1. **The agent's state must be legible.** A workbench earns trust by making running turns, tool calls, approvals, and costs visible without digging.
2. **Two modes, one surface.** Coding sessions and assistant-style monitoring are equally at home; neither may be designed as an afterthought of the other.
3. **Tokens are the design system.** Every visual decision resolves to `theme.css` tokens and `ui/` primitives; one-off values are defects, not style.
4. **Power users first, newcomers not abandoned.** Efficiency and density win ties, but destructive actions stay guarded and empty states teach.
5. **The protocol is the moat.** UI choices should make the multi-client, multi-workspace nature of the runtime feel like a feature, not plumbing.
