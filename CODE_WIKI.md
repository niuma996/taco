# TACO Code Wiki

> **Taco** 是一个基于 Pi Agent 引擎构建的桌面优先 AI 助手系统，通过 Sidecar 进程模式和 NDJSON-over-stdio JSON-RPC 协议，支持多工作区、多会话的智能对话。本文档全面覆盖项目架构、模块职责、关键实现和运行方法。

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [代码仓库结构](#3-代码仓库结构)
4. [核心模块详解](#4-核心模块详解)
   - [4.1 Protocol 协议包](#41-protocol-协议包)
   - [4.2 Shared 共享包](#42-shared-共享包)
   - [4.3 Sidecar 核心服务端](#43-sidecar-核心服务端)
   - [4.4 CLI 命令行工具](#44-cli-命令行工具)
   - [4.5 Desktop 桌面客户端](#45-desktop-桌面客户端)
5. [关键类与函数说明](#5-关键类与函数说明)
6. [依赖关系分析](#6-依赖关系分析)
7. [通信协议规范](#7-通信协议规范)
8. [配置系统](#8-配置系统)
9. [项目运行方式](#9-项目运行方式)
10. [测试体系](#10-测试体系)

---

## 1. 项目概述

### 1.1 项目定位

TACO 是一个 **minimal-viable sidecar protocol layer + multi-client debug terminal**，核心价值在于：

- 提供通用的 **Sidecar 协议层**，让任何语言的客户端都能驱动 AI 助手对话
- 基于 Pi 的 `AgentHarness` 构建，复用成熟的 Agent 引擎能力
- 支持 **多工作区（Multi-Workspace）**、**多会话（Multi-Session）** 并行
- 提供 Tauri 2 + React 桌面客户端，以及 Node/Python 集成示例

### 1.2 核心特性

| 特性 | 说明 |
|------|------|
| **子代理系统 (Agent Tool)** | 按类型工具白名单、`agent/<type>` 命名空间、深度递归保护、并行执行模式 |
| **技能系统 (Skill Tool)** | 按名称加载、内联注入保护、子代理会话隔离 |
| **计划模式 (Plan Mode)** | `planEnter` 打开 `.taco/plans/<slug>.md`，严格限制工具使用，`planExit` 返回审核 |
| **Prompt 标签系统** | 每个 `<tag>` 携带压缩策略（`pin`/`pinOnce`/`summarize`/`drop`）和可见性策略 |
| **扩展系统** | 工作区激活时构建冻结 `WorkspaceExtensionSet`，内置 `projectManifests`/`gitContext`/`outputRedaction` |
| **JSONL 存储** | 会话/历史/事件日志采用 `JsonlSessionStorage` + `JsonlSessionRepo`，仅追加、可重放 |
| **单进程多工作区** | 一个 `taco-sidecar` 进程服务所有工作区，按 `cwd` 路由 |
| **权限代理** | 5 级风险分类（`readOnly`→`privilegeEscape`）、规则式 allow/deny、作用域控制 |
| **MCP 集成** | 支持 stdio 和 Streamable HTTP 两种传输，动态工具注册 |
| **IM 通道** | Channel SDK 框架、会话路由、每工作区策略覆盖 |
| **检查点系统** | Turn 作用域文件快照、客户端驱动的撤销 |

---

## 2. 整体架构

### 2.1 三层架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Layer (客户端层)                         │
│  ┌────────────────────┐  ┌────────────────────┐  ┌───────────────────┐   │
│  │ Tauri Desktop      │  │ Node TUI Example   │  │ Python CLI        │   │
│  │ (React + Tauri 2)  │  │ (@taco-ai/shared)  │  │ (subprocess)      │   │
│  └────────┬───────────┘  └────────┬───────────┘  └────────┬──────────┘   │
│           │ NDJSON                │ NDJSON                │ NDJSON       │
│           │ over stdio/socket     │ over stdio            │ over stdio   │
└───────────┼───────────────────────┼───────────────────────┼──────────────┘
            │                       │                       │
┌───────────▼───────────────────────▼───────────────────────▼──────────────┐
│                       Sidecar Layer (Sidecar 进程层)                       │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ SidecarServer (单例)                                                │   │
│  │  ├─ methodRegistry (RPC 方法路由)                                    │   │
│  │  ├─ workspaceMap: Map<cwd, WorkspaceRuntime>                        │   │
│  │  ├─ channelRegistry + channelBindBroker + conversationRouter        │   │
│  │  └─ Push 转发 (session.event / tools.updated / ...)                 │   │
│  └──────────────────────────┬─────────────────────────────────────────┘   │
│                             │ 1:N                                          │
│  ┌──────────────────────────▼─────────────────────────────────────────┐   │
│  │ WorkspaceRuntime (每个 cwd 一个)                                     │   │
│  │  ├─ NodeExecutionEnv (文件系统 + Shell)                              │   │
│  │  ├─ JsonlSessionRepo (跨会话 .jsonl 列表)                            │   │
│  │  ├─ SessionRegistry + AgentSpawner + ModelRegistry                   │   │
│  │  ├─ PermissionBroker (5 级风险分类)                                   │   │
│  │  ├─ CheckpointManager (Turn 级快照)                                   │   │
│  │  └─ attached: Map<sessionId, AttachedSession>                        │   │
│  └──────────────────────────┬─────────────────────────────────────────┘   │
│                             │ 1:N                                          │
│  ┌──────────────────────────▼─────────────────────────────────────────┐   │
│  │ AttachedSession (每个会话 + AgentHarness)                            │   │
│  │  ├─ Session (从 JsonlSessionStorage 打开)                            │   │
│  │  ├─ AgentHarness (Pi 引擎，事件订阅转发)                             │   │
│  │  ├─ TaskStore + PlanModeState + ImPolicyState                       │   │
│  │  ├─ SessionToolController (延迟工具加载)                             │   │
│  │  └─ prompt / steer / abort / setModel / compact                     │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Scheduler   │  │ Extensions   │  │ Memory       │  │ MCP          │  │
│  │ (Cron Jobs) │  │ System       │  │ System       │  │ Integration  │  │
│  └─────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
            │
            │ 直接调用
┌───────────▼──────────────────────────────────────────────────────────────┐
│                     Pi Agent Engine (上游依赖)                              │
│  @earendil-works/pi-agent-core  +  @earendil-works/pi-ai                   │
│  (AgentHarness / Session / Models / Tools / Compaction)                    │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.2 客户端分层

```
@taco-ai/protocol (零依赖类型层) — 线协议契约
        ▲
        │ 使用
@taco-ai/shared (类型化 RPC 客户端层)
        ▲
        │ 消费
   ┌────┴────┐
   ▼         ▼
Node TUI   @taco-ai/desktop (Tauri 2)
Example    Rust 启动 Sidecar + React UI
```

---

## 3. 代码仓库结构

```
taco/
├── packages/                           # 核心包 (发布到 npm)
│   ├── protocol/                       # 线协议契约 (类型 + 常量)
│   │   └── src/
│   │       ├── schemas/                # RPC 参数验证 schemas (typebox)
│   │       │   ├── agents.ts           # agents.* schemas
│   │       │   ├── channels.ts         # channels.* schemas
│   │       │   ├── checkpoints.ts      # checkpoints.* schemas
│   │       │   ├── commandPermission.ts
│   │       │   ├── extensions.ts
│   │       │   ├── imPolicy.ts
│   │       │   ├── index.ts
│   │       │   ├── initialize.ts       # initialize RPC schema
│   │       │   ├── mcp.ts
│   │       │   ├── memory.ts
│   │       │   ├── sessionLifecycle.ts # session.create/delete/rename
│   │       │   ├── sessionRead.ts      # session.history/snapshot
│   │       │   ├── sessionTurn.ts      # session.prompt/steer/abort
│   │       │   ├── settings.ts
│   │       │   ├── skills.ts
│   │       │   ├── tools.ts
│   │       │   └── workspace.ts        # workspace.list/ensure/dispose
│   │       ├── channels.ts             # IM 通道类型
│   │       ├── checkpoints.ts          # 检查点类型
│   │       ├── config.ts               # taco.json 配置 + 安全视图
│   │       ├── errors.ts               # ErrorCodes 枚举
│   │       ├── frames.ts               # RpcRequest/RpcResponse/ServerPush
│   │       ├── imPolicy.ts             # IM 策略类型
│   │       ├── index.ts                # 统一导出
│   │       ├── memory.ts               # 记忆系统类型
│   │       ├── messages.ts             # AgentMessage DTOs
│   │       ├── push.ts                 # PushMethods 常量 + 载荷类型
│   │       ├── session.ts              # session.* RPC 类型
│   │       └── tools.ts                # tools/skills/agents/askUser 类型
│   │
│   ├── shared/                         # 类型化 Node 客户端
│   │   ├── dispatcher.ts               # FrameDispatcher (推/响应配对)
│   │   ├── rpcMethods.ts               # RPC 方法名常量
│   │   ├── spawn.ts                    # 默认 sidecar spawn 辅助
│   │   ├── tacoClient.ts               # 桶导出 (不含 Node 专属)
│   │   ├── tacoClientBase.ts           # TacoClientBase 基础类
│   │   ├── tacoClientNode.ts           # Node 端适配器 (child_process)
│   │   └── typedRpc.ts                 # createTypedRpc (50+ 类型化方法)
│   │
│   ├── sidecar/                        # NDJSON over stdio 服务进程
│   │   ├── bin/taco-sidecar.cjs        # 入口脚本
│   │   └── src/
│   │       ├── agents/                 # 子代理定义
│   │       ├── channels/               # IM 通道 SDK 框架
│   │       ├── checkpoints/            # 检查点管理 + 存储
│   │       ├── config/                 # 配置加载链 + 指令文件解析
│   │       ├── extensions/             # 扩展系统 (激活/加载/注册)
│   │       ├── lib/                    # 通用工具 (async/logger/fs权限)
│   │       ├── mcp/                    # MCP 客户端/适配器/工具提供
│   │       ├── memory/                 # 记忆系统 (本地存储 + 提取)
│   │       ├── permissions/            # 权限代理 + 命令策略匹配
│   │       ├── plan/                   # 计划模式推送适配
│   │       ├── prompts/                # 系统提示词构建 + 模板
│   │       ├── runtime/                # 运行时核心
│   │       ├── scheduler/              # 调度器 (Cron + 作业管理)
│   │       ├── server/                 # NDJSON 服务器 + RPC 处理器
│   │       ├── skills/                 # 技能系统 (技能去重/前端matter)
│   │       ├── tags/                   # Prompt 标签系统 + 压缩策略
│   │       ├── tasks/                  # 任务管理 (TodoWrite + 持久任务)
│   │       ├── tools/                  # 内置工具集 (18+ 工具)
│   │       ├── upgrader/               # 升级编排器
│   │       └── index.ts                # 主入口 (daemon + stdio 双模)
│   │
│   └── cli/                            # 用户-facing CLI 启动器
│       ├── bin/taco.cjs                # 入口
│       └── lib/
│           ├── index.ts                # 子命令分发
│           ├── start.ts                # 启动守护进程
│           ├── status.ts               # 守护进程状态
│           ├── stop.ts                 # 停止守护进程
│           ├── install.ts              # 注册 launchd/schtasks
│           ├── uninstall.ts            # 卸载启动项
│           ├── upgrade.ts              # 拉取 + 暂存最新版本
│           ├── upgradeApply.ts         # 原子切换至暂存版本
│           └── paths.ts                # TACO_HOME/套接字路径解析
│
├── clients/                            # 客户端实现
│   └── taco-desktop/                   # Tauri 2 + React 桌面客户端
│       ├── src-tauri/                  # Rust 后端
│       │   ├── src/
│       │   │   ├── lib.rs              # Tauri commands (核心)
│       │   │   ├── main.rs             # 二进制入口
│       │   │   ├── sidecar_launcher.rs # Sidecar 启动器解析
│       │   │   ├── daemon_reap.rs      # 孤儿守护进程回收
│       │   │   ├── log_file.rs         # 日志文件轮转
│       │   │   ├── paths.rs            # 路径解析
│       │   │   └── upgrade_commands.rs # 升级命令
│       │   ├── Cargo.toml
│       │   ├── tauri.conf.json
│       │   └── tests/                   # Rust 集成测试
│       │
│       └── src/                        # React 前端
│           ├── components/             # UI 组件
│           │   ├── onboarding/         # 首次引导流程
│           │   ├── panels/             # 功能面板 (TaskPanel/PlanModeIndicator)
│           │   ├── settings/           # 设置面板各 Tab
│           │   ├── toolViews/          # 工具调用可视化视图
│           │   ├── ui/                 # 基础 UI (Button/Select/Slider)
│           │   └── ...                 # 通用组件
│           ├── hooks/                  # 状态管理 Hooks (30+)
│           ├── i18n/                   # 国际化 (en/zh)
│           ├── lib/                    # 客户端工具库
│           ├── styles/                 # CSS 样式
│           ├── views/                  # 主视图 Pane (10+)
│           ├── App.tsx                 # App 根组件
│           └── main.tsx                # React 入口
│
├── examples/                           # 第三方集成示例
│   ├── python-cli/                     # Python 零依赖示例
│   └── node-tui/                       # Node TUI 示例 (@taco-ai/shared)
│
├── docs/                               # 设计文档
│   ├── 01-goal.md                      # 目标与范围
│   ├── 02-architecture.md              # 架构与实现
│   ├── 03-config.md                    # 配置指南
│   ├── 04-testing.md                   # 测试指南
│   ├── sidecar-protocol.md             # 完整线协议规范
│   └── signing.md                      # 签名与发布
│
├── .github/                            # CI/CD + Issue 模板
│   └── workflows/
│       ├── ci.yml                      # 主 CI (lint/typecheck/test/build)
│       ├── release-desktop.yml         # 桌面发布流水线
│       └── release-sidecar.yml         # Sidecar 发布流水线
│
├── package.json                        # 根 package (monorepo 脚本)
├── biome.json                          # Biome Linter/Formatter 配置
├── .node-version                       # Node 版本 (>=22)
└── README.md / README.zh.md            # 项目说明
```

---

## 4. 核心模块详解

### 4.1 Protocol 协议包

**包名**: `@taco-ai/protocol`  
**作用**: 定义线协议契约（Wire Contract），服务端和客户端共享导入，仅包含类型定义和常量，零运行时实现依赖。

#### 4.1.1 帧类型 (frames.ts)

```typescript
// 路由键
type WorkspaceId = string;    // 规范化的绝对路径 cwd
type SessionId = string;      // 服务端生成的 uuidv7

// 协议版本 (语义化: major 必须匹配, minor 向后兼容)
const SIDECAR_PROTOCOL_VERSION = { major: 1, minor: 0 };

// 握手流程
interface InitializeParams {
    protocolVersion: { major: number; minor: number };
    clientCapabilities: ClientCapabilities; // uiLocale 等
}
interface InitializeResult {
    serverVersion: string;
    serverCapabilities: SidecarCapabilities; // methods/pushes/channels
    instanceId: string;                      // 进程唯一标识
    pid: number;
    sessionFormatVersion: number;            // JSONL 历史格式版本
}

// Pull (请求/响应) — JSON-RPC 风格
interface RpcRequest<TParams = unknown> {
    id: string;
    commandId?: string;       // 重试安全的幂等命令标识
    method: string;
    params: TParams;
}

type RpcResponse<TResult = unknown> =
    | { id: string; ok: true; result: TResult }
    | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };

// Push (服务端发起)
interface ServerPush<TParams = unknown> {
    id?: string;              // 可选,客户端去重用
    method: string;           // PushMethods 枚举值
    workspace: WorkspaceId;
    session?: SessionId;
    seq?: number;             // 单调流序列号,间隙检测
    sessionKind?: "main" | "subagent";
    params: TParams;
}
```

**握手强制流程** (v1.0+):
1. 服务端写入: `sidecar.hello` → `{version, pid, instanceId, protocol}`
2. 客户端发送: `initialize` → 校验协议兼容性
3. 服务端回复: `initialize` → 返回能力清单

**未完成握手前**调用任何其他 RPC 均返回 `not_initialized` 错误。

#### 4.1.2 Push 事件类型 (push.ts)

| Push 方法名 | 触发时机 | 载荷说明 |
|-------------|---------|---------|
| `sidecar.hello` | Sidecar 启动时 (即将退役) | 版本/pid/instanceId |
| `session.attached` | 会话被 attach 时 | 空对象 (客户端拉 snapshot) |
| `session.detached` | 会话 detach 时 | 空对象 |
| `session.event` | AgentHarness 通用事件 | `{event: AgentHarnessEvent}` |
| `session.tool_call_start` | 工具调用开始 | toolCallId/toolName/args |
| `session.tool_call_update` | 工具调用流式更新 | toolCallId/partialResult |
| `session.tool_call_end` | 工具调用结束 | toolCallId/isError/result |
| `command_permission.requested` | 需用户授权的命令 | 请求详情 (已脱敏) |
| `subagent.spawned` | 父会话创建子代理 | parentSessionId/subSessionId/agentType |
| `session.error` | 会话终端错误 | error 字符串 |
| `session.compaction_started` | 压缩开始 | tokensBefore |
| `session.compaction_finished` | 压缩结束 (成功或失败) | durationMs/failed/reason |
| `tasks.updated` | 任务列表变更 | active/history 列表 |
| `plan.state.updated` | 计划模式状态变更 | active/currentSlug |
| `models.changed` | 模型配置变更 | 空 (客户端重新拉取) |
| `session.deleted` | 会话被删除 | 空 |
| `channel.status_changed` | IM 通道绑定状态变更 | 状态详情 |
| `channels.conversations_changed` | IM 会话列表变更 | 空 (客户端重新拉取) |
| `im.tools_enabled` | IM 工作区首次启用本地工具 | 通知文本 |
| `im.policy_changed` | IM 策略写入成功 | channelId |
| `im.workspaces_invalidated` | IM 工作区即将被处置 | channelId/interruptedCount |

#### 4.1.3 配置类型 (config.ts)

**磁盘配置形状** (`TacoGlobalConfigShape`):

```typescript
interface TacoGlobalConfigShape {
    defaultModel?: string;
    defaultProvider?: string;
    systemPrompt?: string;
    thinkingLevel?: ThinkingLevel;    // off/minimal/low/medium/high/xhigh/max
    anthropicApiKey?: string;
    openaiApiKey?: string;
    apiKeys?: Record<string, string>;          // 自定义 Provider API Key
    extensions?: string[];                     // npm 扩展包名
    disabledExtensions?: string[];             // 禁用的扩展
    compaction?: { enabled?: boolean; threshold?: number }; // 自动压缩策略
    memoryEnabled?: boolean;
    customProviders?: CustomProviderConfig[];  // 自定义 Provider
    channels?: ChannelInstanceConfig[];        // IM 通道实例
    mcpServers?: McpServerConfig[];            // MCP 服务器
    instructions?: InstructionsConfig;         // 项目指令文件注入
    commandPermissions?: {
        mode: "ask" | "auto";
        rules: string[];  // 通配符: "git *", "npm test *"
    };
    sessionsRoot?: string;                     // JSONL 存储根目录
}
```

**安全视图** (`TacoGlobalConfigView`): 通过 IPC 返回时自动脱敏：
- API Key → `MaskedKey { configured, mask }` (仅显示 sk-ant-…AbCd 格式)
- `mcpServers[i].{env,headers,command,args,url,cwd}` → 完全剥离
- `channels[i].config` → 完全剥离

**命令风险等级** (`CommandRisk`):
1. `readOnly` — 只读 (ls, cat)
2. `workspaceWrite` — 工作区内写入 (npm install, edit)
3. `externalSideEffect` — 外部副作用 (curl, network call)
4. `destructive` — 破坏性 (rm -rf, git reset --hard)
5. `privilegeEscape` — 权限逃逸 (sudo, su)

#### 4.1.4 消息 DTOs (messages.ts)

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// 内容块
type ProtocolContentBlock =
    | TextBlock        // { type: "text", text, textSignature? }
    | ThinkingBlock    // { type: "thinking", thinking, redacted? }
    | ImageBlock       // { type: "image", data(base64), mimeType }
    | ToolCallBlock;   // { type: "toolCall", id, name, arguments }

// 消息类型
interface UserMessage {
    role: "user";
    content: string | ProtocolContentBlock[];
    timestamp: number;
}
interface AssistantMessage {
    role: "assistant";
    content: ProtocolContentBlock[];
    provider?: string;
    model?: string;
    usage?: { input, output, cacheRead, cacheWrite, totalTokens, cost? };
    stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
    timestamp: number;
}
interface ToolResultMessage {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: ProtocolContentBlock[];
    isError: boolean;
    addedToolNames?: string[]; // 动态加载的工具
    timestamp: number;
}
```

---

### 4.2 Shared 共享包

**包名**: `@taco-ai/shared`  
**作用**: 提供类型化客户端层，可在 Node 和浏览器中运行。分三层导出：

| 导出路径 | 内容 | 适用环境 |
|---------|------|---------|
| `.` | `TacoClientBase` / `FrameDispatcher` / `TypedRpc` | 通用 (Node + 浏览器) |
| `./node` | `TacoClient` (Node child_process 适配器) | Node.js |
| `./spawn` | `createDefaultSidecarSpawn` (默认 spawn 辅助) | Node.js |

#### 4.2.1 FrameDispatcher — 核心分发逻辑

[shared/dispatcher.ts](file:///workspace/packages/shared/dispatcher.ts)

```typescript
class FrameDispatcher {
    // 注册待处理请求 → 返回 Promise
    registerPending(id: string, workspace?: string): Promise<unknown>;
    
    // 拒绝请求 (发送失败/超时/进程退出)
    rejectPending(id: string, reason: Error): void;
    rejectWorkspacePending(workspace: string, reason: Error): void;
    rejectAllPending(reason: Error): void;
    
    // 处理一帧 NDJSON 对象
    handleFrame(frame: unknown): void;
    // → 结构分流:
    //   有 `ok: boolean` → RpcResponse → 配对 pending 并 resolve/reject
    //   有 `method` → ServerPush → emit 到 pushBus
    
    // 推送订阅
    onPush(listener: (push: ServerPush) => void): () => void;
}
```

**分发优先级**：
1. 帧带 `ok` 字段 → 响应帧 → 查 `pending` Map 配对
2. 帧带 `method` 字段 → 推送帧 → 转发到监听器
3. 都不满足 → `badFrame` 警告

#### 4.2.2 TypedRpc — 类型化 RPC 方法

[shared/typedRpc.ts](file:///workspace/packages/shared/typedRpc.ts)

`createTypedRpc(dispatch)` 注入 **53 个类型化便捷方法**，覆盖全部 RPC：

**分类辅助函数**:
- `ws0(method, workspace)` — 工作区级无参 RPC
- `wsSession(method, workspace, sessionId, params)` — 会话级 RPC
- `process0(method)` — 进程级无参 RPC
- `process1(method, params)` — 进程级带参 RPC

**主要方法组**:
```typescript
// 工作区管理
workspaceList(): Promise<WorkspaceListResult>
workspaceEnsure(cwd: string): Promise<WorkspaceEnsureResult>
workspaceDispose(cwd: string): Promise<void>

// 会话生命周期
sessionCreate(params): Promise<{ sessionId }>
sessionAttach(workspace, sessionId): Promise<void>
sessionDetach(workspace, sessionId): Promise<void>
sessionDelete(workspace, sessionId): Promise<void>
sessionRename(workspace, sessionId, name): Promise<void>
sessionList(workspace, params): Promise<SessionListResult>

// 会话 Turn 控制
sessionPrompt(workspace, sessionId, prompt): Promise<PromptResult>
sessionSteer(workspace, sessionId, params): Promise<void>
sessionAbort(workspace, sessionId): Promise<AbortResult>
sessionCompact(workspace, sessionId): Promise<SessionCompactResult>

// 会话读取
sessionHistory(workspace, sessionId): Promise<{ leafEntryId, entries }>
sessionSnapshotGet(workspace, sessionId): Promise<SessionSnapshot>
sessionEventsGet(workspace, sessionId, params): Promise<SessionEventsGetResult>
sessionContextInfo(workspace, sessionId): Promise<SessionContextInfoResult>

// 模型
providersList(): Promise<ProvidersListResult>
providerListModels(providerId): Promise<ProviderListModelsResult>
sessionListModels(workspace, sessionId): Promise<ModelInfo[]>
sessionSetModel(workspace, sessionId, provider, model): Promise<void>

// 配置 + 扩展
settingsGet(): Promise<SettingsGetResult>
settingsWrite(params): Promise<SettingsWriteResult>
extensionsStatus(): Promise<ExtensionsStatusResult>

// 工具/技能/代理
toolsList(workspace, sessionId): Promise<ToolsListResult>
skillsList(workspace): Promise<SkillsListResult>
skillsContent(workspace, skillId): Promise<SkillContentResult>
agentsList(workspace): Promise<AgentsListResult>
agentsContent(workspace, agentId): Promise<AgentsContentResult>

// 记忆/任务/MCP/通道/检查点/权限/调度  等
```

#### 4.2.3 典型使用

```typescript
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";

const client = new TacoClient(
    createDefaultSidecarSpawn({ command: "taco-sidecar", args: [] }),
);

await client.start();
await client.waitForReady();  // hello + initialize 握手

client.onPush((frame) => console.log("[push]", frame.method));

const workspaces = await client.workspaceList();
const { sessionId } = await client.sessionCreate({
    workspace: "/path/to/project",
    initialPrompt: "hello",
});
await client.sessionPrompt("/path/to/project", sessionId, "echo ping");
```

---

### 4.3 Sidecar 核心服务端

**包名**: `@taco-ai/sidecar`  
**作用**: NDJSON over stdio 的服务进程，是整个系统的运行时核心。

#### 4.3.1 入口与双模式

[sidecar/src/index.ts](file:///workspace/packages/sidecar/src/index.ts)

**配置加载链** (后者覆盖前者):
1. 环境变量: `TACO_DEFAULT_MODEL`, `TACO_SESSIONS_ROOT`, API keys 等
2. 配置文件: `$TACO_HOME/taco.json`
3. CLI 参数: `--default-model`, `--sessions-root`, `--system-prompt` 等

**运行模式**:

| 模式 | 触发条件 | 传输方式 | 说明 |
|-----|---------|---------|------|
| **Stdio 模式** | 默认 | process.stdin/stdout | 开发调试、直接调用 |
| **Daemon 模式** | `TACO_DAEMON_MODE=1` | Unix Socket / Named Pipe | 生产部署、Tauri 桌面调用 |

**Daemon 模式关键组件**:
- **NDJSON Socket** (`TACO_SOCKET`): 客户端连接，每个连接独立 `SidecarServer`
- **Control Socket** (`TACO_CONTROL_SOCKET`): 单实例锁 + 控制通道 (ping/shutdown)
- **IM Host**: 常驻进程级 `SidecarServer`，拥有 IM 工作区和通道栈
- **Scheduler Runtime**: 常驻进程级 `SidecarServer`，运行 Cron 作业
- **ClientSinkRegistry**: IM 帧扇出到所有已连接桌面

#### 4.3.2 SidecarServer — 服务器单例

[sidecar/src/server/server.ts](file:///workspace/packages/sidecar/src/server/server.ts)

**职责**:
- 通过 `methodRegistry` 分发 RPC 请求到处理器
- 管理 `workspaceMap: Map<cwd, WorkspaceRuntime>`
- 转发 Push 帧到传输层 (NDJSON 序列化 + 写入)
- 管理通道栈 (channelRegistry/bindBroker/conversationRouter)
- 管理 JobsController (调度器挂载)

**关键属性**:
```typescript
interface SidecarServerOptions {
    sessionsRoot?: string;           // JSONL 存储根
    defaultModel?: string;
    defaultProvider?: string;
    systemPrompt?: string;
    defaultThinkingLevel?: ThinkingLevel;
    compaction?: ResolvedCompaction; // 自动压缩策略
    memoryEnabled?: boolean;
    extensionRegistry?: ExtensionRegistry;   // 进程级扩展注册表
    providerKeyStore: ProviderKeyStore;      // API Key 热更新存储
    customProviders?: CustomProviderConfig[];
    mcpServers?: McpServerConfig[];
    channels?: ChannelConfig[];       // IM 通道实例
    jobs?: JobsControl;               // 调度器 API
    // 守护进程模式: 共享通道栈 + IM Host
    channelRegistry?: ChannelRegistry;
    imHost?: ServerRpcSurface;
    clientSinkRegistry?: ClientSinkRegistry;
}
```

**启动流程** (`start()`):
1. 注册内置 RPC 方法 (`registerBuiltinMethods`)
2. 启动通道实例 (如果配置了 channels)
3. 写入 `sidecar.hello` Push 帧
4. 启动命令记录清理器 (幂等重试窗口)
5. 订阅 transport 的输入流 → `handleLine`

#### 4.3.3 WorkspaceRuntime — 工作区运行时

[sidecar/src/runtime/workspace.ts](file:///workspace/packages/sidecar/src/runtime/workspace.ts)

每个 `cwd` 对应一个实例，路由键为规范化的绝对路径。

**关键职责与组件**:

| 组件 | 作用 |
|-----|------|
| `NodeExecutionEnv` | Cwd 绑定的文件系统 + Shell 执行环境 |
| `JsonlSessionRepo` | 跨会话 `.jsonl` 列表 + 元数据缓存 |
| `SessionRegistry` | 会话 CRUD + attach/detach + 事件扇出 |
| `AgentSpawner` | 子代理创建 + `agentContinue` 恢复 |
| `ModelRegistry` | 模型切换 + Provider Key 热更新 |
| `PermissionBroker` | 5 级风险分类 + 规则式 allow/deny |
| `CheckpointManager` | Turn 作用域 pre-write 文件快照 |
| `DefaultDeferredToolRegistry` | 延迟工具候选池 (MCP/Skill) |
| `TaskStore` + `PlanModeState` | 会话级任务/计划状态 |

**公共方法**:
```typescript
class WorkspaceRuntime {
    // 会话管理
    listSessions(): Promise<JsonlSessionMetadata[]>
    getHistory(sessionId): Promise<{ leafEntryId, entries }>
    attach(sessionId, opts?): Promise<AttachedSession>
    detach(sessionId): Promise<void>
    getAttached(sessionId): AttachedSession | undefined
    
    // 模型管理
    listAvailableModels(provider?): ModelInfo[]
    setSessionModel(sessionId, provider, modelId): Promise<void>
    
    // 子代理
    spawnSubagent(args): Promise<{ subSessionId, resultText, isError }>
}
```

**IM 工作区分支** (`im://<channelId>/<peerId>/<chatId>`):
- 使用虚拟 cwd 作为 workspaceMap 键
- 拥有独立的 `ConversationRouter` (peer/chat → sessionId 映射)
- FS 工具被禁用 (`IM_DISABLED_FS_TOOLS`)
- `ImWorkspacePolicy` 叠加在全局权限代理之上

#### 4.3.4 AttachedSession — 会话绑定

[sidecar/src/runtime/attachedSession.ts](file:///workspace/packages/sidecar/src/runtime/attachedSession.ts)

**一个 Session + 一个 AgentHarness** 的绑定单元，是实际执行对话的容器。

**关键属性**:
```typescript
interface AttachedSessionOptions {
    session: Session;                     // JSONL 持久化会话
    models: Models;                       // Pi 的 Models 对象
    env: NodeExecutionEnv;
    model?: Model<Api>;                   // 默认模型
    systemPrompt: string;                 // 完整系统提示词
    tools: TacoTool[];                    // 内置工具集
    resources: AgentHarnessResources;     // Skills + Prompt 模板
    streamOptions: AgentHarnessStreamOptions;
    thinkingLevel?: ThinkingLevel;
    extensionContextHooks?: ContextHookBuckets;    // 扩展 Context Hooks
    extensionToolCallHooks?: ToolCallHook[];       // 扩展工具调用 Hooks
    extensionToolResultHooks?: ToolResultHookBuckets; // 扩展工具结果 Hooks
    compaction?: ResolvedCompaction;      // 自动压缩策略
    memoryStore?: MemoryStore;
    taskStore: TaskStore;                 // 会话任务存储
    planState: PlanModeState;             // 计划模式状态
    toolRegistry?: DeferredToolRegistry;  // 延迟工具加载
}
```

**并发模型**:
- 每个 AttachedSession 持有独立 AgentHarness 实例
- **同一会话的 Turn 串行执行**：第二个 `prompt()` 抛出 `session_busy`
- **不同会话/不同工作区完全并行**
- 子代理运行在独立子会话中，与父会话并行

**Hooks 注入链** (wireHarnessHooks.ts):
1. `dropPolicy` — 按可见性删除 `<tag>` 内容
2. `stripThinking` — 根据 thinkingLevel 控制思考块
3. `pinAwareCompact` — Pin 感知的压缩策略
4. 扩展 Context Hooks (gitContext / projectManifests / outputRedaction 等)
5. `instructionsContext` — CLAUDE.md/AGENTS.md/DESIGN.md 注入
6. `projectContext` — 项目元数据注入
7. `replyLanguage` — 回复语言标签注入
8. `imChannelContext` — IM 通道上下文
9. `compactionReminder` / `todoWriteReminder` — 系统提示
10. `factExtractor` / `memoryExtractor` — 记忆提取
11. Debug Hook — LLM Dump

#### 4.3.5 内置工具集

[sidecar/src/tools/index.ts](file:///workspace/packages/sidecar/src/tools/index.ts)

| 工具名称 | 类别 | 说明 | 元数据 |
|---------|------|------|--------|
| `read` | 文件 | 读取文件 (截断到 ~30k tokens/2000 行)，支持图片 | 只读 |
| `write` | 文件 | 创建或完全替换文件 | 可修改 |
| `edit` | 文件 | 精确字符串替换 (必须已读文件) | 可修改 |
| `grep` | 搜索 | 正则搜索工作区文件 | 只读 |
| `glob` | 搜索 | Glob 模式匹配文件列表 | 只读 |
| `shell` | 执行 | 平台条件式 Shell 执行 (经 PermissionBroker) | 可修改 |
| `askUser` | 交互 | 向用户提问 (单选/多选/文本) | 只读 |
| `todoWrite` | 任务 | 临时任务分解 (ephemeral) | 只读 |
| `taskCreate` | 任务 | 创建持久任务列表 | 只读 |
| `taskUpdate` | 任务 | 更新任务状态/内容 | 只读 |
| `taskList` | 任务 | 列出任务历史 | 只读 |
| `planEnter` | 计划 | 进入计划模式，严格限制工具 | 可修改 |
| `planExit` | 计划 | 退出计划模式，返回计划供审核 | 可修改 |
| `agent` | 子代理 | 按类型创建子代理，深度保护 | 可修改 |
| `skill` | 技能 | 加载技能 (内联注入或子代理模式) | 可修改 |
| `memory` | 记忆 | 读写/删除记忆主题 | 只读 |
| `jobs.*` | 调度 | 创建/更新/列表/禁用调度作业 | 可修改 |
| `addTools` | 动态 | 按需加载延迟工具 (MCP/Skill) | 只读 |

**Shell 工具权限流程**:
1. 执行命令 → `PermissionBroker.evaluate(command)`
2. 返回 `{ behavior: "allow"|"ask"|"deny", risk, reason }`
3. `allow` → 直接执行；`deny` → 返回错误；`ask` → 发送 `command_permission.requested` Push
4. 等客户端 `command_permission.resolve` 回复后继续
5. 记住授权范围: `once` (单次) / `session` (会话) / `global` (全局)

#### 4.3.6 调度器系统 (scheduler/)

| 模块 | 说明 |
|-----|------|
| `runner.ts (Scheduler)` | Cron 表达式触发、并发控制、启动重放 |
| `dispatcher.ts` | 作业调用 WorkspaceRuntime.sessionCreate + prompt |
| `jobsController.ts` | jobs.* RPC 处理器 (CRUD + 状态) |
| `store.ts (JobStore)` | 作业 JSON 持久化，per-id 序列化写入队列 |
| `cronerAdapter.ts` | croner 库适配 |

作业生命周期: `pending` → `triggered` → `running` → `done`/`err`/`cancelled`  
支持 `pinnedSessionId` 把多次触发钉在同一会话上。

#### 4.3.7 扩展系统 (extensions/)

**贡献类型**:
- `context` Hooks — 修改 LLM 输入上下文
- `toolCall` Hooks — 拦截工具调用
- `toolResult` Hooks — 拦截工具结果 (内置 `outputRedaction`)
- `tools` — 注册新工具
- `systemPrompt` — 追加系统提示
- `tags` — 注册自定义 Prompt 标签 (registerExtensionTag)

**生命周期**:
1. 启动时: `loadExtensions()` 从 `taco.json.extensions` 加载 npm 包
2. 工作区激活时: `activateExtensions()` 构建冻结的 `WorkspaceExtensionSet`
3. Attach 时: Hooks 注入到 Harness Hook 链

**内置扩展**:
- `projectManifests` — 读取 package.json/Cargo.toml 等项目清单
- `gitContext` — Git 状态/分支/Diff 上下文注入
- `outputRedaction` — 工具输出脱敏 (API Key/Token 正则)

#### 4.3.8 Prompt 标签系统 (tags/)

每个自定义标签 `<tagName>` 在注册时声明:
- `compression` 策略: `pin`(永不压缩) / `pinOnce`(压缩一次后移除) / `summarize`(正常总结) / `drop`(压缩时直接丢弃)
- `tuiVisibility`: `visible` / `hidden` / `ephemeral` (仅流式显示)

内置标签: `<instructions>`, `<memory>`, `<project_context>`, `<reply_language>`, `<im_channel>`, `<plan_mode>`, `<active_tasks>` 等。

---

### 4.4 CLI 命令行工具

**包名**: `@taco-ai/cli`  
**入口**: `taco` 二进制 (bin/taco.cjs)

[cli/lib/index.ts](file:///workspace/packages/cli/lib/index.ts)

| 子命令 | 说明 | 实现文件 |
|-------|------|---------|
| `taco start` | 启动守护进程 (daemon mode)，打印 NDJSON socket 路径 | start.ts |
| `taco status` | Control Socket ping，检查守护进程存活 | status.ts |
| `taco stop` | Control Socket shutdown，优雅关闭守护进程 | stop.ts |
| `taco install` | 注册到 launchd (macOS) / schtasks (Windows) | install.ts |
| `taco uninstall` | 删除启动项 | uninstall.ts |
| `taco upgrade` | 拉取最新 sidecar，暂存到 staging 目录，写升级标记 | upgrade.ts |
| `taco upgrade --apply` | 原子切换: 关闭旧守护 → 替换 live 目录 → 启动新守护 | upgradeApply.ts |

**守护进程所有权验证** (`daemon_reap`):
- 启动时读取 `$TACO_HOME/run/sidecar.pid` → `{pid, install_id}`
- 比较 `install_id` (基于 `TACO_SIDECAR_RESOURCES` + `TACO_HOME` 的哈希)
- 不匹配 → 不是"我们的"守护进程，跳过回收
- 匹配但 pid 不存活 → 清理 stale socket/pid 文件

---

### 4.5 Desktop 桌面客户端

**包名**: `@taco-ai/desktop` (私有)  
**技术栈**: Tauri 2 + React 19 + Vite + i18next

#### 4.5.1 Rust 后端 (Tauri)

[taco-desktop/src-tauri/src/lib.rs](file:///workspace/clients/taco-desktop/src-tauri/src/lib.rs)

**设计原则**: Rust 只做**进程生命周期管理**和**字节管道**，不解析协议帧。

**共享 Sidecar 模型**:
- 全进程共享**一个** sidecar 子进程，`Arc<Mutex<Option<SharedSidecar>>>`
- Sidecar 内部按 `params.workspace` 路由，无需多进程

**Tauri Commands**:

| Command | 说明 |
|---------|------|
| `workspace_ensure(cwd, debugMode?, llmDumpToFile?)` | 确保共享 sidecar 已启动 (首次调用 spawn) |
| `workspace_send(cwd, line)` | 写入一行 NDJSON 到 sidecar stdin |
| `workspace_dispose_all()` | 优雅关闭 sidecar (3s 超时 → SIGKILL) |
| `set_fs_scope(path)` | 授予 FS 插件路径访问权 |
| `desktop_config_read/write` | 读写 `~/.taco/desktop.json` |
| `default_workspace_dir` | 返回 `$TACO_HOME/workspace/`，mkdir 保证存在 |
| `paths_are_dirs(paths[])` | 批量检查目录存在性，剔除失效 workspace |
| 升级相关 commands | `upgrade_marker_present` / `run_upgrade_apply` |

**Tauri Events (Rust → React)**:
- `sidecar-event` → `{ line: string }` — sidecar stdout 每行原样转发
- `sidecar-exited` → `{ code, reason }` — 进程退出信号

#### 4.5.2 React 前端架构

**状态管理 — 自定义 Hooks 体系** (30+ hooks):

| Hook 分组 | 主要 Hooks | 说明 |
|----------|-----------|------|
| **工作区/会话** | `useWorkspaces` | 核心状态机: workspaces 列表、活动会话、sendPrompt/abort 等 |
| **Sidecar 流** | `useSidecarStream` | Push 帧分发 + 事件 log + 重连循环 |
| **聊天 UI** | `useChatInputState` | 输入框状态、附件、快捷键 |
| **面板 Hooks** | `useToolsPane` / `useSkillsPane` / `useAgentsPane` / `usePluginsPane` / `useMemoryPane` / `useChannelsPane` / `useCheckpointsPane` / `useConversationsPane` | 各侧边栏面板状态 |
| **设置** | `useProviders` / `useWorkspaceModels` / `useGlobalConfig` | 模型/Provider/配置管理 |
| **工具** | `useAskUser` / `useSubagent` / `useFileTree` / `useFilePreview` | 工具调用交互 |
| **通用** | `useTheme` / `useToast` / `useI18n` / `useLlmDump` / `useImPolicy` | 基础设施 |

**核心视图 Pane** (views/):
- `Sidebar.tsx` — 左侧: 工作区切换 + 会话列表
- `ChatPane.tsx` — 中央: 消息流 + 输入框
- `SettingsPane.tsx` — 设置 (Appearance/Model/Context/Permissions/MCP/Schedules/Updates/Debug)
- 其余: `AgentsPane` / `SkillsPane` / `ToolsPane` / `PluginsPane` / `MemoryPane` / `ChannelsPane` / `CheckpointsPane`

**客户端工具库** (lib/):
- `sidecar.ts` — Tauri invoke 薄包装: `ensureWorkspace/send/disposeAll/onPush/onExit`
- `tacoClientTauri.ts` — 基于 Tauri transport 的 `TacoClient` 实现
- `workspaceReducer.ts` — 工作区状态 Reducer (workspaceMap, push 应用)
- `sessionPushProcessor.ts` — Push 帧应用到本地消息列表
- `applyEventToMessages.ts` — `AgentHarnessEvent` → 消息列表增量更新
- `markdownHelpers.ts` / `chatUtils.ts` — Markdown 渲染 + 聊天工具函数
- `globalConfig.ts` — 侧车配置缓存 (`settings.get` 结果)
- `clientSettings.ts` / `desktopConfig.ts` — 客户端本地设置

**样式** (styles/): 30 个 CSS 文件，按 UI 区域划分 (sidebar.css / chatMessages.css / toolCards.css / settings.css / theme.css 等)

**国际化** (i18n/): `en.json` + `zh.json`，覆盖 UI 所有文案。初始化时从 `navigator.language` 推断，也可从 desktopConfig 覆盖。

---

## 5. 关键类与函数说明

### 5.1 服务端核心类

| 类名 | 文件路径 | 核心职责 |
|-----|---------|---------|
| **SidecarServer** | [sidecar/src/server/server.ts](file:///workspace/packages/sidecar/src/server/server.ts) | NDJSON 服务器单例，RPC 路由，Push 转发，工作区 Map 管理 |
| **WorkspaceRuntime** | [sidecar/src/runtime/workspace.ts](file:///workspace/packages/sidecar/src/runtime/workspace.ts) | 单个 cwd 运行时门面：会话/模型/子代理/权限/检查点 |
| **AttachedSession** | [sidecar/src/runtime/attachedSession.ts](file:///workspace/packages/sidecar/src/runtime/attachedSession.ts) | 会话绑定 Harness：prompt/steer/abort/compact + Hooks 注入 |
| **FrameDispatcher** | [shared/dispatcher.ts](file:///workspace/packages/shared/dispatcher.ts) | 客户端帧分发器：响应配对 + Push 订阅 (零依赖浏览器兼容) |
| **PermissionBroker** | [sidecar/src/permissions/permissionBroker.ts](file:///workspace/packages/sidecar/src/permissions/permissionBroker.ts) | 5 级风险评估 + 规则匹配 + 授权记忆 (once/session/global) |
| **ModelRegistry** | [sidecar/src/runtime/modelRegistry.ts](file:///workspace/packages/sidecar/src/runtime/modelRegistry.ts) | 模型目录：内置 + 自定义 Provider，Key 变更热更新 |
| **AgentSpawner** | [sidecar/src/runtime/agentSpawner.ts](file:///workspace/packages/sidecar/src/runtime/agentSpawner.ts) | 子代理创建：工具白名单 + 深度递归保护 + agentContinue |
| **SessionToolController** | [sidecar/src/runtime/sessionToolController.ts](file:///workspace/packages/sidecar/src/runtime/sessionToolController.ts) | 延迟工具串行加载，Promise 链防并发 |
| **CompactionController** | [sidecar/src/runtime/compactionController.ts](file:///workspace/packages/sidecar/src/runtime/compactionController.ts) | 自动压缩触发 + Pin-aware 摘要生成 + 前后通知 |
| **Scheduler** | [sidecar/src/scheduler/runner.ts](file:///workspace/packages/sidecar/src/scheduler/runner.ts) | Cron 调度器：启动重放 + 并发控制 + 每作业锁文件 |
| **JobsController** | [sidecar/src/scheduler/jobsController.ts](file:///workspace/packages/sidecar/src/scheduler/jobsController.ts) | 作业 CRUD + 运行历史 + running 标记持久化 |
| **ExtensionRegistry** | [sidecar/src/extensions/registry.ts](file:///workspace/packages/sidecar/src/extensions/registry.ts) | 扩展注册/贡献合并 + Tag 注册 |
| **ChannelRegistry** | [sidecar/src/channels/registry.ts](file:///workspace/packages/sidecar/src/channels/registry.ts) | 通道实例注册表 + 出站推送链 |
| **ConversationRouter** | [sidecar/src/channels/conversationRouter.ts](file:///workspace/packages/sidecar/src/channels/conversationRouter.ts) | IM 路由: (channelId, peerId, chatId) → sessionId |
| **DefaultDeferredToolRegistry** | [sidecar/src/runtime/deferredToolRegistry.ts](file:///workspace/packages/sidecar/src/runtime/deferredToolRegistry.ts) | MCP/Skill 延迟工具候选池 + load() 调用适配器 |
| **McpToolProvider** | [sidecar/src/mcp/mcpToolProvider.ts](file:///workspace/packages/sidecar/src/mcp/mcpToolProvider.ts) | MCP 服务器发现：并行连接 → listTools → 注册为 ToolCandidate |
| **CheckpointManager** | [sidecar/src/checkpoints/manager.ts](file:///workspace/packages/sidecar/src/checkpoints/manager.ts) | Turn 前快照 → 写入索引 → 按 seq restore |
| **UpgradeOrchestrator** | [sidecar/src/upgrader/orchestrator.ts](file:///workspace/packages/sidecar/src/upgrader/orchestrator.ts) | 守护进程内升级探测：每 6h 检查 marker → 命中则 self-shutdown |

### 5.2 关键函数

| 函数名 | 位置 | 说明 |
|-------|-----|------|
| **resolveConfig()** | sidecar/config/config.ts | 三层配置合并 (env → taco.json → CLI args) + 校验 |
| **activateExtensions()** | sidecar/extensions/activation.ts | 工作区激活: 合并 builtin + workspace 扩展贡献 |
| **buildSystemPrompt()** | sidecar/prompts/buildSystemPrompt.ts | 组装系统提示词: 全局前缀 + 平台 + 工具摘要 + 技能 + 扩展 |
| **createDefaultSidecarSpawn()** | shared/spawn.ts | Node 默认 spawn: 解析启动器 + 设置 env + 超时处理 |
| **startServer()** | sidecar/server/server.ts | 工厂: 构造 SidecarServer → start → 返回 { ready, stop } |
| **dispatchRpc()** | sidecar/server/server.ts | 自我 RPC 入口: 工具 (memory/jobs) 调用同进程 RPC |
| **emitPush()** | sidecar/server/push.ts | 统一 Push 出口: 序列化 + 写 transport + IM sink 扇出 |
| **withTacoUserAgent()** | sidecar/runtime/attachedSession.ts | 注入 `taco/<version>` UA (非 OAuth) + `x-taco-sidecar-version` 头 |
| **defaultToolsWithTasks()** | sidecar/tools/index.ts | 工具工厂: 基础 7 工具 + 任务 5 工具 + 计划 2 工具 + 记忆 + 作业 |
| **wireHarnessHooks()** | sidecar/runtime/hookWiring.ts | Harness Hook 安装总入口: 标签系统 → 压缩 → 扩展 → 调试 |

### 5.3 服务端 RPC Handlers

所有处理器位于 `sidecar/src/server/handlers/`，共 57 个：

| 处理器文件 | 覆盖 RPCs |
|-----------|----------|
| initialize.ts | initialize (握手，强制) |
| workspace.ts | workspace.list / workspace.ensure / workspace.dispose |
| sessionLifecycle.ts | session.create / attach / detach / delete / rename / list |
| sessionTurn.ts | session.prompt / steer / abort / submitAnswers (turnStart=true) |
| sessionRead.ts | session.history / snapshot.get / events.get |
| sessionRuntime.ts | session.setModel / setThinkingLevel / listModels / contextInfo / compact |
| sessionTasksGet.ts | session.tasks.get / taskHistory.get |
| tools.ts | tools.list |
| skills.ts | skills.list / skills.content |
| agents.ts | agents.list / agents.content |
| settings.ts | settings.get / settings.write |
| extensions.ts | extensions.status |
| commandPermission.ts | command_permission.resolve |
| checkpoints.ts | checkpoints.list / checkpoints.restore |
| memory.ts | memory.list / write / deleteTopic / upsert |
| mcp.ts + mcpView.ts | mcp.listServers / getConfig / createConfig / updateConfig / deleteConfig |
| channels.ts | channels.list / listConversations / create / bind / submitVerifyCode / unbind |
| imPolicy.ts | imPolicy.get / setChannelDefault / setChatOverride / clearChatOverride |
| providers.ts / providerModels.ts | providers.list / provider.listModels |
| jobs.ts | 调度器 8 个 RPC |
| catalog.ts | session.planState.get |

---

## 6. 依赖关系分析

### 6.1 Monorepo 内部依赖

```
@taco-ai/protocol (leaf, 零内部依赖)
    ▲
    │ 唯一内部依赖
@taco-ai/shared
    ▲        ▲
    │        │
@taco-ai/sidecar  │
    ▲        │
    │        │
@taco-ai/cli   @taco-ai/desktop
 (私有)
```

### 6.2 外部核心依赖

| 依赖名 | 使用包 | 版本 | 作用 |
|-------|--------|-----|------|
| `@earendil-works/pi-agent-core` | sidecar | `^0.83.0` | Agent Harness 核心: Session/Turn/Hooks/Compaction |
| `@earendil-works/pi-ai` | sidecar | `^0.83.0` | AI 模型抽象: Providers/Models/API 适配 |
| `@modelcontextprotocol/sdk` | sidecar | `1.30.0` | MCP 协议客户端: stdio/HTTP 连接 + listTools/callTool |
| `typebox` | protocol/sidecar | `^1.3.10` | Schema 构造 + 运行时验证 (RPC params) |
| `croner` | sidecar | `^9.0.0` | Cron 表达式解析 + 调度触发器 |
| `fast-glob` | sidecar | `^3.3.3` | 文件系统 Glob 匹配 (glob 工具) |
| `gray-matter` | sidecar | `^4.0.3` | Markdown 前端 matter 解析 (Skill/Agent 定义) |
| `ignore` | sidecar | `^7.0.6` | .gitignore 规则匹配 (FS 工具边界) |
| `yaml` | sidecar | `^2.9.0` | YAML 解析 (配置/清单) |
| `@tauri-apps/*` | desktop | `^2.0.0` | Tauri 2 API + FS/Store/Dialog/Opener/Updater 插件 |
| `react` / `react-dom` | desktop | `^19.2.8` | UI 框架 |
| `@radix-ui/react-*` | desktop | 各版本 | 无障碍 UI 原语 (Dialog/Dropdown/Select/Slider/Switch) |
| `react-markdown` / `remark-gfm` | desktop | `^10.1.0` / `^4.0.1` | Markdown + GFM 渲染 |
| `@shikijs/rehype` | desktop | `^4.4.1` | 代码高亮 |
| `i18next` / `react-i18next` | desktop | `^26.3.6` / `^17.0.11` | 国际化 |
| `lucide-react` | desktop | `^1.28.0` | 图标库 |
| `tar` | cli | `^7.4.3` | 升级包解压 (.tar.gz) |
| `@biomejs/biome` | 根 devDep | `^2.5.6` | Linter + Formatter (替代 ESLint/Prettier) |
| `tsx` | 各包 devDep | `^4.23.5` | TypeScript ESM 即时运行 (开发/测试) |

### 6.3 开发环境要求

```json
// .node-version
Node.js >= 22
pnpm >= 11.5.0  // packageManager
```

---

## 7. 通信协议规范

### 7.1 帧格式 (NDJSON over stdio/socket)

```
每行一个 JSON 对象:

→ 请求:
{"id":"r1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}

← 响应:
{"id":"r1","ok":true,"result":{"cwd":"/tmp/x","sessionsRoot":"..."}}
{"id":"r2","ok":false,"error":{"code":"session_busy","message":"..."}}

← 推送:
{"method":"session.event","workspace":"/tmp/x","session":"<uuid>",
 "params":{"event":{"type":"message_start",...}}}
```

### 7.2 完整生命周期示例

```
客户端                         Sidecar stdout              Sidecar 内部
  │                                │                            │
  │─ RpcRequest(initialize) ──────>│                            │
  │                                │  校验协议版本/能力          │
  │<─ RpcResponse(init OK) ────────│  ← 握手完成               │
  │                                │                            │
  │─ RpcRequest(session.create) ──>│  → 创建 .jsonl            │
  │<─ RpcResponse(sessionId) ──────│                            │
  │                                │                            │
  │─ RpcRequest(session.prompt) ──>│  → attach + Harness.prompt│
  │                                │     ↓ message_start (push) │
  │<─ push: message_start ─────────│<───│                      │
  │                                │     ↓ message_update×N     │
  │<─ push: message_update×N ──────│<───│                      │
  │                                │     ↓ message_end          │
  │<─ push: message_end ───────────│<───│                      │
  │                                │     ↓ tool_call_start      │
  │<─ push: tool_call_start ───────│<───│                      │
  │                                │     ↓ tool_call_end        │
  │<─ push: tool_call_end ─────────│<───│                      │
  │                                │     ↓ turn_end             │
  │<─ push: turn_end ──────────────│<───│                      │
  │                                │     ↓ agent_end            │
  │<─ push: agent_end ─────────────│<───┘                      │
  │<─ RpcResponse(assistant) ──────│  ← return assistantMsg    │
```

**注意**: Push 在 Response **之前**到达，因为 LLM 流式输出先于 prompt() 解析完成。

### 7.3 路由键

| 级别 | 键 | 说明 |
|-----|-----|------|
| 工作区级 (primary) | `WorkspaceId = string` | 规范化绝对路径，或 `im://<channel>/<peer>/<chat>` |
| 会话级 (secondary) | `SessionId = string` | 服务端 uuidv7，客户端也可指定复用 |

### 7.4 幂等重试

```typescript
interface RpcRequest {
    id: string;              // 每请求唯一，响应配对用
    commandId?: string;      // 用户操作标识，跨重试保持不变
    method: string;
    params: unknown;
}
```

服务端存储 `(workspace, sessionId, commandId)` → `CommandOutcome`，默认 TTL 5 分钟、最大 1000 条。相同 commandId 的第二个请求直接返回缓存结果，不重复执行。

### 7.5 会话事件流序号

Push 帧的 `seq` 字段是每个 `(workspace, sessionId)` 流的单调递增整数。客户端可用于：
- 检测间隙 (`lastSeq + 1 !== currentSeq`)
- 需要时触发 `session.events.get` 补齐缺失
- Reset 规则：重新 attach 后 seq 重置为 1

---

## 8. 配置系统

### 8.1 存储路径 (TACO_HOME = ~/.taco/)

| 路径 | 所有者 | 权限 | 说明 |
|-----|--------|-----|------|
| `~/.taco/taco.json` | sidecar+desktop | `0600` | 全局配置 (API keys 等敏感信息) |
| `~/.taco/desktop.json` | desktop | `0600` | 客户端本地设置 (主题、引导状态) |
| `~/.taco/sessions/<workspaceHash>/<sid>.jsonl` | sidecar | | 会话历史 (JSONL append-only) |
| `~/.taco/sessions/<sid>/tasks/*.json` | sidecar | | 会话任务持久化 |
| `~/.taco/channels/<channelId>.json` | 通道 SDK | `0600` | 通道凭据 (不在 taco.json 中) |
| `~/.taco/checkpoints/<wsHash>/blobs/<sha256>` | sidecar | | 检查点内容寻址存储 |
| `~/.taco/im-workspace-policies/<id>.json` | sidecar | | 每通道 IM 策略 |
| `~/.taco/jobs/*.json` | sidecar | | 调度作业定义 |
| `~/.taco/logs/` | desktop/sidecar | `0600` | 日志 (10MB 轮转，保留 3 份) |
| `~/.taco/run/` | sidecar | | 套接字 + pid 文件 + 锁 |

### 8.2 taco.json 完整示例

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "defaultProvider": "anthropic",
  "systemPrompt": "你是一个简洁高效的助手。",
  "thinkingLevel": "medium",
  "anthropicApiKey": "sk-ant-...",
  "openaiApiKey": "sk-...",
  "apiKeys": {
    "custom:my-provider": "sk-..."
  },
  "compaction": {
    "enabled": true,
    "threshold": 0.7
  },
  "memoryEnabled": true,
  "commandPermissions": {
    "mode": "ask",
    "rules": [
      "git status",
      "git diff",
      "ls *",
      "cat *",
      "npm test *",
      "pnpm test *"
    ]
  },
  "customProviders": [
    {
      "id": "custom:my-provider",
      "name": "My Provider",
      "api": "chatcomplete",
      "baseUrl": "https://api.example.com/v1",
      "models": [
        { "id": "my-model-1", "contextWindow": 128000, "maxTokens": 8192 }
      ]
    }
  ],
  "mcpServers": [
    {
      "id": "my-mcp-server",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "alwaysLoaded": ["search_code"]
    }
  ],
  "extensions": [],
  "disabledExtensions": [],
  "instructions": {
    "enabled": true,
    "files": {
      "claudeMd": true,
      "agentsMd": true,
      "designMd": false
    },
    "inheritToSubagents": true
  }
}
```

### 8.3 环境变量

| 变量名 | 说明 |
|-------|------|
| `TACO_HOME` | 配置/存储根目录 (默认 ~/.taco) |
| `TACO_DEFAULT_MODEL` | 默认模型 (最低优先级, 被 taco.json 覆盖) |
| `TACO_SESSIONS_ROOT` | JSONL 存储根 |
| `TACO_DAEMON_MODE` | `=1` 启用守护进程模式 |
| `TACO_SOCKET` | 守护进程 NDJSON socket 路径 |
| `TACO_CONTROL_SOCKET` | 守护进程 control socket 路径 |
| `TACO_SIDECAR_RESOURCES` | Sidecar 安装根目录 (升级标识) |
| `TACO_DEBUG_LLM_PAYLOAD` | `=1` 启用 LLM payload 调试输出 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / ... | 直接被 pi-ai 读取的 API Key |

---

## 9. 项目运行方式

### 9.1 环境准备

```bash
# 1. 克隆仓库
git clone <repo-url> taco
cd taco

# 2. 确认 Node 版本 (>=22)
node --version  # 应输出 v22.x.x
cat .node-version  # 可使用 fnm/nvm 自动切换

# 3. 安装依赖
pnpm install
# 如提示 [ERR_PNPM_IGNORED_BUILDS], 在 pnpm-workspace.yaml 允许:
# allowBuilds:
#   '@biomejs/biome': true
#   esbuild: true
```

### 9.2 开发模式

#### 方案 A: 只跑 Sidecar (stdio 模式，调试协议)

```bash
cd packages/sidecar
pnpm dev  # tsx watch src/index.ts, NDJSON 写入 stdout
```

从另一个终端用任何 NDJSON 客户端驱动它，或者用 debug-console:

```bash
pnpm dev:console  # 基于 @taco-ai/shared 的交互式调试终端
```

#### 方案 B: 跑 Tauri 桌面客户端 (完整体验)

```bash
cd clients/taco-desktop
pnpm install      # desktop 有自己额外的依赖
pnpm tauri:dev    # 同时启动 Vite(React HMR) + Tauri dev
```

首次启动会显示引导流程 (OnboardingModal)：
1. Welcome 页 → 介绍
2. Provider 页 → 选 Anthropic/OpenAI/Custom
3. Model 页 → 选具体模型
4. Workspace 页 → 选/添加工作区目录
5. Done 页 → 进入主界面

#### 方案 C: 跑完整守护进程 (CLI 管理)

```bash
# 构建包
pnpm build

# 启动守护进程 (CLI 方式)
cd packages/cli
tsx lib/index.ts start
# 输出: NDJSON socket 路径

# 状态检查
tsx lib/index.ts status  # → control.ping pong

# 停止
tsx lib/index.ts stop
```

### 9.3 构建与发布

```bash
# 全量构建 (所有 packages)
pnpm build

# 本地 CI 预检 (lint + typecheck + 循环依赖 + 测试 + 构建 + 打包冒烟)
pnpm ci:local

# 单包构建
pnpm protocol:build  # protocol → tsc
pnpm shared:build    # shared → tsc
cd packages/sidecar && pnpm build  # sidecar → esbuild (单文件 bundle)
cd packages/cli && pnpm build      # cli → esbuild

# Sidecar 发布前烟雾测试
pnpm pack:smoke  # 打包 → 安装到临时目录 → 握手测试
```

### 9.4 发布流水线 (.github/workflows/)

| 流水线 | 触发 | 产物 |
|-------|-----|------|
| ci.yml | PR / push main | lint + typecheck + madge circular + 全量测试 |
| release-sidecar.yml | tag `sidecar-v*` | 发布 `@taco-ai/protocol`/`shared`/`sidecar`/`cli` 到 npm |
| release-desktop.yml | tag `desktop-v*` | Tauri 桌面多平台构建 + 签名 |

---

## 10. 测试体系

### 10.1 测试分层

```
┌─────────────────────────────────────────┐
│ 集成测试 (Integration Tests)            │
│  - channels/integration.test.ts         │  (IM 通道端到端)
│  - mcp/mcpStdio.e2e.test.ts             │  (MCP stdio 端到端)
│  - extensions/integration.test.ts       │  (扩展激活+Hook)
│  - scheduler/dispatcher.integration.test.ts
│  - runtime/attachedSession.*.test.ts    │  (完整 attach → prompt 流)
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│ 单元测试 (Unit Tests)                    │
│  - config/config.*.test.ts              │  (配置合并+校验)
│  - permissions/*.test.ts                │  (风险评估+规则匹配)
│  - prompts/prompts.test.ts              │  (系统提示词快照)
│  - tools/*.test.ts (部分)               │  (工具输入验证)
│  - dispatcher/typedRpc 单元             │  (shared 包)
│  - 30+ 其他模块级测试文件
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│ Schema / Frame 测试                      │
│  - protocol/src/frames.test.ts          │  (帧形状)
│  - protocol/src/push.test.ts            │  (推送载荷)
│  - methodRegistry 验证                  │  (handlers + schema 匹配)
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│ Desktop 组件/钩子测试 (vitest)           │
│  - tests/components/**/*.test.tsx       │  (Settings Tabs/FilesDrawer/MemoryPane)
│  - tests/hooks/**/*.test.tsx            │  (useFileTree/useFilePreview/useToast...)
│  - tests/lib/**/*.test.ts               │  (workspaceReducer/chatUtils/theme)
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│ Tauri Rust 集成测试                      │
│  - tests/daemon_reap_integration.rs     │  (孤儿守护进程回收)
│  - tests/install_publish.rs             │  (安装+发布路径)
│  - tests/log_file.rs                     │  (日志文件)
└─────────────────────────────────────────┘
```

### 10.2 运行测试

```bash
# 全量 (packages + clients 下所有 .test.ts)
pnpm test

# 单包测试
cd packages/sidecar && pnpm test
cd clients/taco-desktop && pnpm test       # 组件/库测试
cd clients/taco-desktop && pnpm test:files  # 额外 vitest 组件测试

# 特定测试文件 (sidecar 内)
pnpm --filter @taco-ai/sidecar test:memory
pnpm --filter @taco-ai/sidecar test:prompts
pnpm --filter @taco-ai/sidecar test:extensions

# 端到端
pnpm test:e2e  # debug-console e2e (完整会话交互)
```

### 10.3 测试模式 (sidecar 服务器)

sidecar 的 `server.ts` 支持传入 `NullTransport`：所有 Push 写入黑洞、所有 RPC 通过 `dispatchRpc()` 直接调用，无需真实 stdio。这让大部分测试可以直接构造完整 SidecarServer 实例跑端到端而不依赖子进程。

`tests/_helpers/` 提供:
- `inMemoryTransport.ts` — 双端内存管道 (测试真实帧字节流)
- `fakeMcpClient.ts` — 假 MCP 客户端，返回指定工具列表
- `fakeToolCollection.ts` — 假工具集合，记录调用次数
- `testTags.ts` — 测试用自定义标签

---

## 附录 A: 快速参考

### A.1 Monorepo 脚本 (根 package.json)

| 脚本 | 说明 |
|-----|------|
| `pnpm build` | 递归构建所有包 |
| `pnpm dev:sidecar` | Sidecar 开发模式 (tsx watch) |
| `pnpm dev:desktop` | Tauri 桌面开发模式 |
| `pnpm dev:console` | Debug Console 开发模式 |
| `pnpm lint` | Biome 检查 (lint + format) |
| `pnpm typecheck` | 全仓库 TypeScript 类型检查 |
| `pnpm test` | 全量测试 (Node 原生 test runner) |
| `pnpm deps:circular` | madge 循环依赖检测 |
| `pnpm deps:orphans` | madge 孤儿文件检测 |
| `pnpm sidecar:docs` | 重新生成 docs/sidecar-protocol.md (从 RPC 定义) |
| `pnpm ci:local` | 完整本地 CI (等于 GitHub Actions CI) |
| `pnpm release:preflight` | 发布前预检 (版本/变更日志) |

### A.2 常见错误码

| Error Code | 来源 | 说明 |
|-----------|------|------|
| `not_initialized` | server.ts | initialize 握手未完成就调用其他 RPC |
| `session_busy` | sessionTurn.ts | 会话已有 turn 在执行，第二个 prompt/steer 被拒 |
| `session_not_found` | handlers | sessionId 在 workspace 中不存在/未 attach |
| `workspace_not_found` | handlers | cwd 未通过 workspace.ensure 建立 |
| `invalid_params` | validation.ts | RPC 参数 typebox 校验失败 |
| `unknown_method` | methodRegistry.ts | method 名未注册 |
| `mcp_connect_error` | mcpToolProvider | MCP 服务器连接/listTools 失败 |
| `command_denied` | shellTool.ts | PermissionBroker 明确 deny |
| `im_policy_violation` | permissionBroker | IM 策略覆盖禁止了该命令 |

---

## 附录 B: 文件路径索引 (核心入口)

| 功能 | 入口文件 |
|-----|---------|
| Sidecar 启动入口 | [packages/sidecar/src/index.ts](file:///workspace/packages/sidecar/src/index.ts) |
| Sidecar Server 主类 | [packages/sidecar/src/server/server.ts](file:///workspace/packages/sidecar/src/server/server.ts) |
| WorkspaceRuntime | [packages/sidecar/src/runtime/workspace.ts](file:///workspace/packages/sidecar/src/runtime/workspace.ts) |
| AttachedSession | [packages/sidecar/src/runtime/attachedSession.ts](file:///workspace/packages/sidecar/src/runtime/attachedSession.ts) |
| 工具注册入口 | [packages/sidecar/src/tools/index.ts](file:///workspace/packages/sidecar/src/tools/index.ts) |
| 权限代理 | [packages/sidecar/src/permissions/permissionBroker.ts](file:///workspace/packages/sidecar/src/permissions/permissionBroker.ts) |
| RPC 方法列表 | [packages/shared/rpcMethods.ts](file:///workspace/packages/shared/rpcMethods.ts) |
| 帧类型定义 | [packages/protocol/src/frames.ts](file:///workspace/packages/protocol/src/frames.ts) |
| Push 事件定义 | [packages/protocol/src/push.ts](file:///workspace/packages/protocol/src/push.ts) |
| 配置类型定义 | [packages/protocol/src/config.ts](file:///workspace/packages/protocol/src/config.ts) |
| CLI 子命令分发 | [packages/cli/lib/index.ts](file:///workspace/packages/cli/lib/index.ts) |
| Tauri Rust 入口 | [clients/taco-desktop/src-tauri/src/lib.rs](file:///workspace/clients/taco-desktop/src-tauri/src/lib.rs) |
| React App 根组件 | [clients/taco-desktop/src/App.tsx](file:///workspace/clients/taco-desktop/src/App.tsx) |
| 客户端 Sidecar 包装 | [clients/taco-desktop/src/lib/sidecar.ts](file:///workspace/clients/taco-desktop/src/lib/sidecar.ts) |
| 工作区状态 Hook | [clients/taco-desktop/src/hooks/useWorkspaces.ts](file:///workspace/clients/taco-desktop/src/hooks/useWorkspaces.ts) |

---

*本文档基于仓库主分支代码生成，涵盖架构设计、核心模块、关键实现和运行方式。对于具体实现细节的变更，请以源码和 docs/ 目录下的设计文档为准。*
