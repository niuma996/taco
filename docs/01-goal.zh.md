# Taco — 目标与定位

> 本文回答"Taco 是什么、为什么做、不做什么"。

## 一句话定义

**Taco** 是一个**最小可用的 sidecar 协议层 + 多客户端调试终端**，封装 Pi 的
`@earendil-works/pi-agent-core` AgentHarness 与 `@earendil-works/pi-ai` Models，
对外暴露一套**基于 NDJSON over stdio 的 JSON-RPC 协议**，让任何语言、任何
进程的客户端都能发起多 workspace 多 session 的对话、查询历史、订阅流式增量。

## 这次项目存在的理由

工程是空仓库从零搭建。背景：

- **Pi 有引擎，但没有通用客户端协议。** Pi 团队已经把 agent 引擎下沉到
  `pi-agent-core`（AgentHarness 提供多 hook 事件，session 持久化由
  `pi-agent-core/harness/session` 抽象）。
- **Tauri + NDJSON 模式已经验证可行。** 另一个工具的 `desktop` 子项目走通
  了 "Tauri + NDJSON over stdio" 模式，但耦合到那个项目自己的 sidecar
  实现，没有把这部分能力通用化。
- **Taco 抽出跨项目共有的接缝。** 本项目把 "Pi harness 之上 + 多客户端可
  调 + 多 workspace 多 session" 这条能力做成**独立 sidecar**
  （`@taco-ai/sidecar`），配套类型化 Node 客户端（`@taco-ai/shared`）和
  类型化契约（`@taco-ai/protocol`），外加一个 Tauri 2 + React 桌面端。

## 范围（In Scope）

| 能力 | 描述 |
|---|---|
| **协议层** | NDJSON over stdio + JSON-RPC 风格（pull 请求/响应 + push 持续帧）|
| **运行时** | 一个 sidecar 进程内**多 workspace + 多 session**，按 cwd 路由 |
| **pull 接口** | workspace.list / ensure / dispose、session.list / create / attach / detach / history / prompt / steer / abort / setModel / listModels，以及 settings.* / channels.* / imPolicy.* / mcp.* / memory.* / commands_permission.* / skills.* / agents.* / checkpoints.* / tools.* / provider.* / extensions.* 全部 RPC。完整列表见 `docs/sidecar-protocol.md` |
| **push 事件** | sidecar.hello、session.attached / detached / event / error / deleted / tool_call_{start,update,end}、subagent.spawned、session.compaction_{started,finished}、tasks.updated、plan.state.updated、models.changed、channel.status_changed、channels.conversations_changed、im.tools_enabled、im.policy_changed |
| **历史还原** | 通过 `session.history` 拉取完整 chat tree（entries + leafEntryId），客户端自行重建分支 |
| **模型配置** | 走独立 config 目录 `~/.taco/taco.json`（`TacoGlobalConfigShape`），sessions 默认在 `~/.taco/sessions/` |

```
        ╔══════════════════════════════════════════╗
        ║                  taco                     ║
        ║ ┌──────────────────────────────────────┐  ║
        ║ │  sidecar (NDJSON-RPC over stdio)     │  ║
        ║ │  ┌─────────────────────────────────┐ │  ║
        ║ │  │ WorkspaceRuntime × N (per cwd)   │ │  ║
        ║ │  │   └── AttachedSession × M        │ │  ║
        ║ │  │       └── AgentHarness (1)      │ │  ║
        ║ │  └─────────────────────────────────┘ │  ║
        ║ └──────────────────────────────────────┘  ║
        ║                  ↕ JSON-RPC over stdio     ║
        ║ ┌──────────────────────────────────────┐  ║
        ║ │  desktop (Tauri + React)            │  ║
        ║ └──────────────────────────────────────┘  ║
        ╚══════════════════════════════════════════╝
                          ↓ depends on
        ┌──────────────────────────────────────────┐
        │  pi-agent-core (AgentHarness, Session…)   │
        │  pi-ai        (Models, streamSimple…)     │
        └──────────────────────────────────────────┘
```