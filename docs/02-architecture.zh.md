# 架构与实现

> 本文深入解释 Taco sidecar 的协议层、运行时、客户端设计，以及为什么这样拆。

## 1. 协议层

### 1.1 物理层：NDJSON over stdio

每行一个 JSON 帧：

```
请求:  {"id":"r1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}
响应:  {"id":"r1","ok":true,"result":{"cwd":"/tmp/x","sessionsRoot":"..."}}
推送:  {"id":"<uuid>","method":"session.event","workspace":"/tmp/x","session":"<id>","params":{"event":<AgentHarnessEvent>}}
```

为什么 NDJSON over stdio 而不是别的：

- **零依赖**——只需 Node.js 自带 `readline` + `process.stdout`/`process.stdin`
- **父子进程管道天然**——subprocess.stdin/.stdout 直接拿来用，不需要别的协议层
- **人类可读**——调试时直接 `cat` 流能看到发生了什么
- **可换 transport**——HTTP / Unix socket 是另外的 transport，NDJSON 的 `line` 抽象可以不变

### 1.2 帧类型

#### Pull 请求 / 响应（JSON-RPC 风格）

```typescript
interface RpcRequest<TParams> {
    id: string;        // 客户端生成,配对用
    method: string;    // 形如 "workspace.ensure" / "session.prompt"
    params: TParams;
}

type RpcResponse<TResult> =
    | { id: string; ok: true; result: TResult }
    | { id: string; ok: false; error: { code: string; message: string; data?: unknown } };
```

#### Push 帧（服务端主动）

```typescript
interface ServerPush<TParams> {
    id?: string;                   // 可选(主要用作 dedupe)
    method: string;                // "session.event" / "session.attached" …
    workspace: WorkspaceId;       // 一级路由
    session?: SessionId;          // 二级路由(可选)
    params: TParams;
}
```

push 帧**自己带 method**——客户端靠 `method` 字段识别事件类型，**不要**用 `id` 配对（`id` 留给 pull 配对）。

### 1.3 Method 列表

完整定义见 [`packages/protocol/src/types.ts`](../packages/protocol/src/types.ts) 的 `Methods` 常量：

```typescript
export const Methods = {
    WorkspaceList:        "workspace.list",
    WorkspaceEnsure:      "workspace.ensure",
    WorkspaceDispose:     "workspace.dispose",
    SessionList:          "session.list",
    SessionCreate:        "session.create",        // 含可选 initialPrompt
    SessionAttach:        "session.attach",
    SessionDetach:        "session.detach",
    SessionHistory:       "session.history",       // 拉完整 chat tree
    SessionPrompt:        "session.prompt",        // 同步等回复
    SessionSteer:         "session.steer",
    SessionAbort:         "session.abort",
    SessionSetModel:      "session.setModel",      // 切模型
    SessionListModels:    "session.listModels",    // 列可用的 model
};
```

Push 帧 method：

```typescript
// 协议 v2: 不再发送 sidecar.hello 推送帧; 启动身份信息(serverVersion / pid /
// instanceId)由 initialize RPC 的响应承载。
"session.attached"  // attach 完成
"session.detached"
"session.event"     // AgentHarness emit 的事件直透(详见 §2.3)
"session.error"
```

### 1.4 路由 key

- **`workspace`（一级 key）** = cwd 的绝对路径（resolved & normalized）
- **`session`（二级 key）** = 由 server 端生成的 `uuidv7`（也可以 client 指定复用）

**为什么用 cwd 而不是 workspace name？**

cwd 是文件系统层面的"项目目录"标识，pi 的现有 model（`pi-coding-agent` 私有）
也用 cwd 隔离 sessions；避免引入额外命名空间导致跟其它工具冲突。

## 2. 运行时

### 2.1 三层结构

```
┌────────────────────────────────────────────────────────────────┐
│ SidecarServer  (单例,持 Map<cwd, WorkspaceRuntime>)             │
│  ├─ 处理 RPC dispatch (Methods.X → handler)                     │
│  ├─ 维护 workspaceMap                                            │
│  └─ 转发 session.event (push 帧 → stdout)                        │
└─────────────┬──────────────────────────────────────────────────┘
              │ 1:N
┌─────────────▼──────────────────────────────────────────────────┐
│ WorkspaceRuntime  (按 cwd 实例化,持 NodeExecutionEnv + Repo)    │
│  ├─ 持有 JsonlSessionRepo (跨 session 浏览 .jsonl)              │
│  ├─ 持有 Models (createModels())                                 │
│  ├─ 缓存 metadataList (workspace 维度的 list)                   │
│  └─ 维护 attached: Map<sessionId, AttachedSession>             │
└─────────────┬──────────────────────────────────────────────────┘
              │ 1:N
┌─────────────▼──────────────────────────────────────────────────┐
│ AttachedSession  (一个 Session + 一个 AgentHarness)              │
│  ├─ 持有 Session (JsonlSessionStorage.open 的结果)              │
│  ├─ 持有 AgentHarness (harness.subscribe 转发 event)            │
│  └─ 提供 prompt / steer / abort / setModel 转发到 harness       │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 WorkspaceRuntime

**职责**

- 持有 `NodeExecutionEnv`（cwd-bound file system + shell）
- 持有一个 `JsonlSessionRepo`，按 cwd 列出历史 `.jsonl`
- 管理该 cwd 下所有 attached sessions
- 提供 listAvailableModels(provider?) 给客户端拉可用 model 列表

**关键 API**

```typescript
class WorkspaceRuntime {
    async listSessions(): Promise<JsonlSessionMetadata[]>   // 拉 .jsonl list
    async getHistory(sessionId): { leafEntryId, entries }   // 拉 chat tree

    async attach(sessionId): Promise<AttachedSession>       // 懒创建 harness
    async detach(sessionId): void
    getAttached(sessionId): AttachedSession

    listAvailableModels(provider?: string): ModelInfo[]
    async setSessionModel(sessionId, provider, modelId): Promise<void>
}
```

**Cache 策略**

`_metadataCache` 存 workspace 下的 metadata list。**只在显式 mutate（create/import）后 invalidate**：

```typescript
this.invalidateListCache();   // 写操作后调
```

读操作（`session.list`）相对昂贵（要走 `listDir` + 每个 `.jsonl` 读 header），所以缓存是值得的。

### 2.3 AgentHarness 事件流（push 通道）

AgentHarness 自带事件总线（`AgentHarnessEvent` 包含 `message_start`/`message_update`/`message_end`/`turn_end`/`agent_end` 等）。

AttachedSession 通过 `harness.subscribe(listener)` 拿到事件流，再 emit 成 EventEmitter 上的 `"event"`：

```typescript
// runtime/workspace.ts
const unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
    attached.emit("event", event);
});
```

WorkspaceRuntime 再转发成 `"session.event"` 事件：

```typescript
attached.on("event", (e) => this.emit("session.event", { sessionId, event: e }));
```

最终 SidecarServer 把这些事件序列化成 NDJSON 帧，写到 stdout：

```typescript
ws.on("session.event", (e: any) => {
    this.emit("runtimePush", {
        id: randomUUID(),
        method: "session.event",
        workspace: cwd,
        session: e.sessionId,
        params: { event: e.event },
    });
});
```

**关键设计**：

- push 帧 ID 是服务端 `randomUUID()`，仅用作客户端 dedupe；**不能**用来配对 pull 请求
- 一个 session 的所有 events 都带 `sessionId`，客户端可按 session 维度聚合
- WorkspaceRuntime 也用 EventEmitter，所以 `server.on("session.attached" / "session.detached" / "session.error")` 直接订阅即可

### 2.4 AttachedSession — 并发模型

每个 AttachedSession 独占一个 AgentHarness 实例。AgentHarness 内部的 `phase` 字段（`"idle" | "turn" | "compaction" | "branch_summary"`）是**实例级**状态：非 idle 时再调 `prompt()` 会抛 `AgentHarnessError("busy")`。

因此并发粒度是 **session**，不是 workspace：

- **同一 workspace 内的多个 session 完全并行**——各自持有独立的 AgentHarness 实例，phase 互不影响
- **多 workspace 同样完全并行**
- 唯一被串行化的是**对同一个 session 的并发 turn**：sidecar 在 RPC 层按 `(workspace, sessionId)` 拒绝，返回 `session_busy`（见 2.6）。这是为了避免用户消息在同一对话分支上交错
- Subagent 跑在**自己的子 session** 中，同样是独立 harness，与父 session 并行

```typescript
class AttachedSession {
    async prompt(text: string, images?: any[]): Promise<AgentMessage> {
        return await this.harness.prompt(text, images ? { images } : undefined);
    }
    async steer(text: string): Promise<void>       { return this.harness.steer(text); }
    async abort(): Promise<AbortResult>            { return this.harness.abort(); }
    async setModel(model: Model<any>): Promise<void> { return this.harness.setModel(model); }
    async dispose(): Promise<void> { /* unsubscribe + harness.abort() */ }
}
```

### 2.5 配置加载

加载顺序（后者覆盖前者）：

```
env (TACO_*, ANTHROPIC_API_KEY, ...)
  → $TACO_HOME/taco.json
  → CLI 参数
```

`$TACO_HOME` 默认 `~/.taco/`（可用 `TACO_HOME` 环境变量覆盖）。

`taco.json` 的 on-disk shape 是
[`packages/protocol/src/config.ts`](../packages/protocol/src/config.ts) 里
的 `TacoGlobalConfigShape`。字段：

- `defaultModel` / `defaultProvider` — 模型选择
- `systemPrompt` — 全局系统提示前缀
- `thinkingLevel` — 新会话默认 thinking level
- `apiKeys` / `anthropicApiKey` / `openaiApiKey` — provider 凭证，经
  `ProviderKeyStore` 镜像到 `process.env`
- `sessionsRoot` — `.jsonl` 存储目录，默认 `$TACO_HOME/sessions/`
- `compaction` — `{ enabled, threshold }`（默认 `true` / `0.7`）
- `commandPermissions` — `{ mode: "ask" | "auto", rules: string[] }`
- `customProviders` — 第三方 OpenAI / Anthropic 兼容端点（id 必须
  带 `custom:` 前缀）
- `mcpServers` — 每服务器 stdio / Streamable HTTP MCP 配置
- `channels` — IM 渠道实例（manifest + 渠道专属 config）
- `extensions` / `disabledExtensions` — npm 扩展白名单
- `instructions` — 项目上下文指令开关（CLAUDE.md / AGENTS.md /
  DESIGN.md）

**safe view**：`settings.get` / `settings.write` 返回的是
`TacoGlobalConfigView`，跨 IPC 边界前剥离所有秘密字段：

- `apiKeys` / `anthropicApiKey` / `openaiApiKey` → `MaskedKey`
- `mcpServers[i].{env,headers,command,args,url,cwd}` → 丢弃
- `channels[i].config` → 丢弃

加载顺序的 `merge` 语义详见
[`packages/sidecar/src/config/config.ts`](../packages/sidecar/src/config.ts)。

### 2.5a Channel layer (IM)

> **注：** Channel layer 段落当前中文版落后于英文版，留作独立 PR
> 同步。英文版 §2.5 Channel layer (IM) 是权威描述，定义了 IM 工作
> 空间与普通工作空间隔离的边界。

### 2.5a MCP 工具动态接入

`mcpServers` 数组是 `TacoGlobalConfigShape` 的可选字段，每项是一份独立的 stdio / Streamable HTTP MCP server 配置。接入路径：

1. **发现**：每个 workspace attach 时由 `discoverMcpTools` 并行 connect + listTools，把每把工具映射为 `ToolCandidate`，按 `mcp__<serverId>__<toolName>` 命名（sanitize + dedupe）后挂到 `DeferredToolRegistry`。
2. **调用**：`McpToolAdapter` 把 `McpToolInfo` 转成 `AgentHarnessTool`。`inputSchema` 直接透传为 pi 的 `parameters`（Anthropic provider 只读 `schema.properties` / `schema.required`，typebox `Value.Check` 对裸 JSON Schema 也工作）。调用走 `McpClientHandle.callTool` 复用已开的连接。
3. **生命周期**：`WorkspaceRuntime.dispose()` 释放 `toolRegistry`，最终 `McpClientHandle.close()` 关闭所有 MCP 子进程 / HTTP 连接。

`alwaysLoaded` 命中的工具标记为 `loading: "always"`。在 `AttachedSession.create` 中，先于 harness 构造并行 `load()` 这些 always 候选并并入 `initialTools`，attach 即生效——失败视为 fatal（attach 中断，UI 显式提示重启后重试）。其余工具仍走 addTools 的 deferred 流程。

**安全语义**：

- MCP 工具执行 **不**经过 `PermissionBroker`。在 `McpServerConfig` 字段注释和 sidecar-protocol.md 中显式标注：配置一个 server 等于对其中每一把工具的隐式授权。
- 失败隔离：单个 server 在 discover / call 时抛错只产生 `log.warn`，不中断其他 server 也不打断 turn。`details.isError` 在 `McpToolExecDetails` 上传递。
- 跨 SDK 版本的 `callTool` 返回类型用 `unknown[]` + adapter 窄化，避免锁定 SDK 版本。

**重启是必须代价**：toolset 在 attach 时一次性构建，settings.write 改 `mcpServers` 只会落盘 + 影响 `mcp.listServers` 的实时输出，新工具要等到下次 workspace attach 才可见（通常通过 sidecar 重启触发）。desktop MCP 设置面板提供「应用并重启」按钮明说这个事实。

### 2.6 单进程作用域

phase 1 是**单 sidecar 进程复用多 workspace/session**：

- TUI / IDE 客户端如果只跑一个 workspace，1 个 sidecar 就够
- 多 workspace 时：单进程内部按 `Map<cwd, WorkspaceRuntime>` 路由
- session 并发不受 workspace 限制：`SessionRegistry.attached` 按 `sessionId` 索引，一个 workspace 可同时挂载任意多个 active session
- 唯一的并发闸门是 `SidecarServer.activeTurnCommands`，key 为 `(workspace, sessionId)`：同一 session 的第二个 turn 命令返回 `session_busy`，跨 session、跨 workspace 均不受影响。仅 `session.prompt` 与 `session.submitAnswers` 参与该闸门（`turnStart: true`）

## 3. 客户端

### 3.1 客户端分层

```
┌─────────────────────────────────────────────┐
│  @taco-ai/shared (通用 NDJSON client)         │  → 任何 Node / tsx 进程能用
│  TacoClient / TypedTacoClient              │
└─────────────────┬───────────────────────────┘
                  │ 被消费
       ┌──────────┴────────────┐
       ▼                       ▼
┌─────────────────────┐  ┌─────────────────────────────────┐
│ Node TUI 示例（社区）   │  │ @taco-ai/desktop (Tauri 2 骨架)    │
│                       │  │ Rust spawn sidecar + React UI    │
└─────────────────────┘  └─────────────────────────────────┘
```

### 3.2 `@taco-ai/shared` 设计要点

`TacoClient`（基类）做原始 NDJSON：

- `start()`：spawn 子进程（默认 `tsx packages/sidecar/src/index.ts`），搭 `readline` 解析每行 NDJSON
- `call(method, params)`：写到 stdin，缓存 `Promise` 到 `pending: Map<id, {resolve, reject}>`，收到响应时 resolve
- `onPush(handler)`：注册 push 监听器
- `dispose()`：SIGTERM 子进程，等 1 秒，超时 SIGKILL

`TypedTacoClient`（子类）做 typed convenience methods：

```typescript
workspaceList(): Promise<WorkspaceId[]>
workspaceEnsure(cwd): Promise<{cwd, sessionsRoot}>
sessionList(workspace): Promise<{workspace, sessions: SessionMeta[]}>
sessionCreate({workspace, initialPrompt?, sessionId?}): Promise<{sessionId, filePath?, assistantMessage?}>
sessionAttach(workspace, sessionId): Promise<{attached: true}>
sessionHistory(workspace, sessionId): Promise<{leafEntryId, entries}>
sessionPrompt(workspace, sessionId, text): Promise<AssistantMessage>
sessionSteer(workspace, sessionId, text): Promise<void>
sessionAbort(workspace, sessionId): Promise<AbortResult>
sessionSetModel(workspace, sessionId, provider, modelId): Promise<{switchedTo}>
sessionListModels(workspace, provider?): Promise<{models: ModelInfo[]}>
```

**dispatch 优先级**：先判断 `frame.method` 是不是存在（push 帧），再看 `frame.id` 是不是在 pending Map 配对 response——避免 push 帧被误识别成 response。

### 3.3 `@taco-ai/desktop` Tauri 骨架

- **Rust 后端 (`src-tauri/src/lib.rs`)**：
  - `workspace_ensure(cwd)` — spawn 一个 sidecar 子进程（用 `tokio::process::Command`），按 cwd 路由存进 `HashMap<String, WorkspaceHandle>`
  - `workspace_send(cwd, line)` — 写 NDJSON 到 stdin
  - `workspace_dispose(cwd)` / `workspace_dispose_all()` — 杀进程
  - 用 `tauri::Emitter` 把 stdout NDJSON 帧 emit 成 Tauri 事件 `sidecar-event`
- **React 前端 (`src/`)**：
  - `lib/sidecar.ts` — 封装 `invoke('workspace_ensure' / 'workspace_send' / ...)` 和 `listen('sidecar-event')`
  - `lib/tacoClient.ts` — 基于 Tauri event 流做 typed client（跟 `@taco-ai/shared` 用法一样，但 spawn 在 Rust 层）
  - `App.tsx` — 多 workspace sidebar + session list + chat pane（已能展示 push 增量）

**Rust 端注意点**（已踩过坑）：

- `#[tauri::command] async fn` 拿到的 `State<'_, ...>` 不能跨 `.await` hold lock — 否则 deadlock
- 修正模式：在 `lock()` 内 clone 出所需的 `mpsc::Sender`、然后释放锁，再 `send().await`

## 4. 数据流示例

### 4.1 一次完整 prompt 的消息流

```
client                    sidecar stdout         sidecar internals
  │                             │                       │
  │── RpcRequest (prompt) ─────>│                       │
  │                             │  dispatch →           │
  │                             │  WorkspaceRuntime.attach      │
  │                             │  AttachedSession.prompt       │
  │                             │      ↓                AgentHarness.prompt
  │                             │      ↓                ├─ message_start (push)
  │<── push: message_start ─────│<─    │                │
  │                             │      ↓                ├─ message_update (push, 多次)
  │<── push: message_update ────│<─    │                │
  │                             │      ↓                ├─ message_end (push)
  │<── push: message_end ───────│<─    │                │
  │                             │      ↓                ├─ turn_end (push)
  │<── push: turn_end ─────────│<─    │                │
  │                             │      ↓                ├─ agent_end (push)
  │<── push: agent_end ────────│<─    │                │
  │                             │                       └─ return assistantMessage
  │<── RpcResponse (assistant)──│                       │
```

### 4.2 为什么 push 优先于 response

prompt() 是同步的（等完整回复才 resolve），但 LLM 流式输出需要实时推。

设计取舍：

- **async streaming**：服务端开始 streaming 后立即开始 push 帧；prompt 还没 resolve，client 已经能拿到增量文本
- **pull 客户端拉历史**：`session.history` 一次性拉完整 chat tree（客户端按 `leafEntryId` + `entries` 自建分支）
- **push 持续增量**：`session.event` 帧持续推 AgentHarness emit 的所有 event

这套组合让客户端可以做到 **"先拉全量 history 还原现场，再订阅 push 持续增量"**。
