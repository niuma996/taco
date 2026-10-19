# Taco — 目标与定位

> 本文回答"Taco 是什么、为什么做、不做什么"。

## 一句话定义

**Taco** 是一个**最小可用的 sidecar 协议层 + 多客户端调试终端**，封装 Pi 的
`@taco-ai/pi-harness` AgentHarness 与 `@earendil-works/pi-ai` Models，
对外暴露一套**基于 NDJSON over stdio 的 JSON-RPC 协议**，让任何语言、任何
进程的客户端都能发起多 workspace 多 session 的对话、查询历史、订阅流式增量。

## 这次项目存在的理由

工程是空仓库从零搭建。背景：

- **Pi 有引擎，但没有通用客户端协议。** Pi 团队已经把 agent 引擎下沉到
  独立的 harness 包（AgentHarness 提供多 hook 事件，session 持久化由其
  `harness/session` 抽象）。Pi 1.0 移除了该包，因此 Taco 把 `0.99.2`
  的接口面以 `@taco-ai/pi-harness` 承接下来。
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
| **握手（v2+）** | 强制 `initialize` RPC；握手完成前服务端拒绝一切非 `initialize` 调用，返回 `not_initialized`。`initialize` 响应携带 `serverVersion`、`pid`、`instanceId`、`protocolVersion`（此前由已下线的 `sidecar.hello` push 帧投递的身份信息）。完整契约见 `docs/sidecar-protocol.md` |
| **pull 接口** | `workspace.list / ensure / dispose`、完整 `session.*` 生命周期（create / attach / detach / delete / rename / history / events.get / snapshot.get / prompt / steer / followUp / cancelQueued / abort / setModel / setThinkingLevel / compact / contextInfo / submitAnswers / tasks.get / taskHistory.get / planState.get / listModels）、`providers.list`、`provider.listModels`、`settings.get/write`、`extensions.status`、`agents.list/content`、`tools.list`、`skills.list/content`、`memory.list/write/deleteTopic/upsert`、`commandPermission.resolve`、`subagent.abort`、`mcp.listServers/getConfig/createConfig/updateConfig/deleteConfig`、`channels.list/listConversations/create/bind/submitVerifyCode/retry/unbind`、`imPolicy.get/setChannelDefault/setChatOverride/clearChatOverride`、`checkpoints.list/restore` |
| **push 事件** | `session.attached / detached / event / error / deleted`、`session.tool_call_{start,update,end}`、`subagent.spawned`、`session.compaction_{started,finished}`、`tasks.updated`、`plan.state.updated`、`models.changed`、`channel.status_changed`、`channels.conversations_changed`、`im.tools_enabled`、`im.policy_changed`、`im.workspaces_invalidated`、`command_permission.requested`、`subagent.settled`、`session.renamed` |
| **历史还原** | 通过 `session.history` 拉取完整 chat tree（entries + `leafEntryId`），客户端自行重建分支。`session.snapshot.get` 一次往返即返回 history + tasks + plan 状态。`session.events.get` 按 `seq` 回放单个 session 的事件日志 |
| **动态工具加载** | 工具分为 `always`（attach 时常驻）与 `deferred`（经 `addTools` 按需加载）。MCP server、skill subagent 及其它 deferred 来源填充候选池 |
| **项目上下文指令** | 按优先级链解析 `CLAUDE.md` / `AGENTS.md` / `DESIGN.md`，包成 `<instructions>` 标签前置到每一次 LLM 调用。由 `taco.json.instructions` 开关控制 |
| **Subagent 系统** | 每个 agent 的工具白名单、按深度设限的递归保护、`agentContinue` 续跑、经 `agent` 工具派生独立子 session、按工具名划命名空间 |
| **Plan 模式** | `planEnter` / `planExit` 工具，plan 文档持久化在 `.taco/plans/<slug>.md`，执行期强制硬闸门 |
| **Tasks 系统** | `todoWrite`（临时拆解）+ `taskCreate/Update/List`（持久化的命名清单）、per-session task store、`tasks.updated` push |
| **Memory 系统** | `~/.taco/memory/MEMORY.md` + `projects/<id>/<slug>.md` 按主题分文件存储、基于 hash 的乐观并发、自动抽取 hook |
| **权限 broker** | 5 级风险分级（readOnly / workspaceWrite / externalSideEffect / destructive / privilegeEscape）、基于规则的 ask/allow/deny、作用域（once / session / global）、subagent 继承、IM workspace policy 覆盖 |
| **IM 渠道** | 渠道 SDK 框架；`channels.*` 管理接口 + `imPolicy.*` 按 workspace 覆盖；`channel.status_changed` 与 `im.*` push |
| **MCP** | stdio + Streamable HTTP 两种 transport、经 `DeferredToolRegistry` 动态注册工具、`mcp.listServers` 健康探测、`alwaysLoaded` 常驻集合 |
| **检查点** | turn 级的写前文件快照；`checkpoints.list` / `checkpoints.restore` 供客户端驱动撤销 |
| **配置** | `$TACO_HOME` 下的 `taco.json`（默认 `~/.taco/`）；settings view 屏蔽秘密字段（API key → `MaskedKey`；`mcpServers[i].{env,headers,command,args,url,cwd}` 与 `channels[i].config` 被剥离） |
| **桌面客户端** | Tauri 2 + React（`@taco-ai/desktop`）；Node.js TUI 示例（复用 `@taco-ai/protocol` 共享类型） |
| **i18n** | 桌面 UI 内置 en + zh；`initialize.clientCapabilities.uiLocale` 传递到每一轮的 `<reply_language>` 标签 |
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
        │  pi-harness (AgentHarness, Session…)      │
        │  pi-ai        (Models, streamSimple…)     │
        └──────────────────────────────────────────┘
```