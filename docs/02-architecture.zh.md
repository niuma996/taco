# 架构与实现

> 本文深入解释 Taco sidecar 的协议层、运行时、客户端设计，以及为什么这样拆。

## 0. 项目要点

Taco 在 Pi 的 harness 之上补了什么，从代码里能看到的：

- **`agent` 工具 —— 可 fan-out 的 subagent。** 按类型配工具白名单、`agent/<type>` 命名空间、深度受限的递归、`executionMode: "parallel"` 支持并发调用。
- **`skill` 工具 —— inline 或 subagent 两种形态。** 按名字加载；inline 形态入队一条由 `skillReinjector` 保护的 `<skill_body name="NAME">` 消息，subagent 形态则经 `spawnSkillSubagent` 开一个新 session。
- **带硬闸门的 Plan 模式。** `planEnter` 打开 `.taco/plans/<slug>.md`；期间只允许 read / askUser / 写 plan 文档；`planExit` 把 plan 交回审批。
- **Prompt tag 体系。** 每个 `<tag>` 块带 `compression` 策略（`pin` / `pinOnce` / `summarize` / `drop`）与 `tuiVisibility`（`visible` / `hidden` / `ephemeral`）；感知 pin 的 compact hook 直接读这张注册表。
- **扩展系统。** 新能力以扩展的形式接入，而不是写死进运行时；workspace 激活时把进程级与 workspace 级贡献合并为一个冻结的 `WorkspaceExtensionSet`，扩展可自带 tag。
- **JSONL 存储。** session / history / event log 全部走 `JsonlSessionStorage` + `JsonlSessionRepo` —— 只追加、可回放、无 schema 迁移。
- **Pi 作为依赖。** `@taco-ai/pi-harness` `0.1.0` 与 `pi-ai` `1.3.0`；直接消费上游 API。`pi-harness` 承载了 Pi 1.0 从 `pi-agent-core` 移除的 `AgentHarness` API，接口面冻结在 `0.99.2`，运行在当前 `pi-ai` 版本线上。
- **独立部署。** `@taco-ai/sidecar` 是带自己 bin 的独立 npm 包，支持两种运行模式 —— 直接的 `NDJSON over stdio`（任何语言都能这么驱动它）与 `taco start` 及 Tauri 桌面端所用的常驻 daemon 模式。见 §2.8。
- **单 daemon 多 workspace。** 一个 daemon 服务 UI 打开的每一个 workspace，按 `cwd` 路由；同一条 NDJSON socket 还能并发承载多个客户端的流量。

## 0.1 接下来在做什么

harness 这层仍在建设：

- **Plan / Tasks / Memory 继续打磨。** 提醒节奏、hook 顺序、抽取 prompt 的质量都还在演进。
- **编码能力以扩展的形式落地。** 打补丁 / 重构 / 跑测试都走扩展系统。
- **加固安全边界。** `PermissionBroker` 已经能隔离只读 subagent、支持按 workspace 的 IM 策略；沙箱与更细粒度的 IM 策略是下一步。

## 1. 协议层

### 1.1 物理层：NDJSON over stdio 或 daemon socket

每行一个 JSON 帧：

```
请求:  {"id":"r1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}
响应:  {"id":"r1","ok":true,"result":{"cwd":"/tmp/x"}}
推送:  {"id":"<uuid>","method":"session.event","workspace":"/tmp/x","session":"<id>","params":{"event":<AgentHarnessEvent>}}
```

Taco 在同一 NDJSON `line` 抽象上支持两种传输模式：

- **stdio 模式** —— 父子进程管道（`process.stdin` / `process.stdout`）。
  每个客户端独占一个 sidecar 进程，生命周期跟父进程绑定。`@taco-ai/shared`
  的 typed client 与各集成示例走的就是这条路径（见 §3.2）。
- **daemon 模式** —— sidecar 作为常驻进程运行，通过 Unix domain socket
  (`<runtime>/sidecar.sock`，Windows: `\\.\pipe\taco-sidecar-<slug>`) 承载 NDJSON 流量，
  并用独立的 control socket (`<runtime>/sidecar-ctl.sock`,
  Windows: `\\.\pipe\taco-sidecar-ctl-<slug>`) 处理 `start` / `status` / `stop`。
  Tauri 桌面端和 `taco start` 走这条路径；详见 §3.3 与 §2.8。

两种模式对调用方是透明的 —— typed client 不需要知道自己在哪条 transport 上。模式由启动方式决定（CLI 通过环境变量、桌面端通过 Tauri 配置）。

为什么选 NDJSON：

- **零依赖** —— stdio 模式只需 Node 自带 `readline` + `process.stdout`/`process.stdin`；daemon 模式只需一个 Unix socket reader。
- **父子进程管道天然**——subprocess.stdin/.stdout 直接拿来用，不需要别的协议层
- **人类可读** —— 调试时直接 `cat` 流能看到发生了什么（stdio 模式）
- **可换 transport**——HTTP / WebSocket 是另外的 transport，NDJSON 的 `line` 抽象可以不变

### 1.2 帧类型

#### Pull 请求 / 响应（JSON-RPC 风格）

```typescript
interface RpcRequest<TParams> {
    id: string;        // 客户端生成,配对用
    commandId?: string; // stable retry identity for deduplicated mutations
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
    seq?: number;                // per-session replay cursor
    sessionKind?: "main" | "subagent";
    params: TParams;
}
```

push 帧**自己带 method**——客户端靠 `method` 字段识别事件类型，**不要**用 `id` 配对（`id` 留给 pull 配对）。

### 1.3 契约与校验

RPC 与 push 清单位于 `docs/sidecar-protocol.md`，由 `pnpm sidecar:docs`
生成。请求形状只在 `packages/protocol/src/schemas/<domain>.ts` 定义一次，
params 类型从 schema 推导。`rpcContract/<domain>.ts` 的一行声明绑定方法名、
客户端路由 scope、schema 与结果类型，派生 `RPC`、`rpcContract` 和
`rpcSchemas`。Push 名称与 payload DTO 定义在 `push.ts`。

`registerMethod` 将 handler 类型绑定到契约行。服务端先校验 params，再解析
workspace、调用 handler；schema 失败返回 `invalid_params` 与
`data.issues` 字段路径，不转换输入、不删除字段。权限、状态、冲突和跨字段
规则由 handler 检查。`initialize` 刻意交给握手 handler 校验，配置 patch
内部保持开放。结果与 push payload 目前只有类型，没有运行时 schema。

shared facade 与进程内 self-RPC 使用同一契约。编译期守卫检查方法覆盖、
params 类型和路由 scope；JSON 往返测试检查 facade 实际发出的 payload。

### 1.3.1 协议边界

- 主数据通道使用上述契约，通过 stdio 或 daemon socket 传输。
- daemon control socket 使用独立请求/响应格式处理 `control.ping` 与
  `control.shutdown`，由 `controlChannel.ts` 和 `shared/controlNode.ts`
  实现，不属于主数据通道契约。
- 桌面 React ↔ Rust commands/events 属于 Tauri IPC。`workspace_send`
  用 `{ cwd, line }` 包装序列化后的数据帧，Rust 原样转发 line。
  `desktop_config_*`、文件授权与升级命令是桌面接口，不加入主 RPC 表。

桌面收到 `settings.get` 的 `{ global }` 后，才组合 `{ global, client, loaded }`。
客户端偏好与 `desktop.json` 由桌面层拥有。主 RPC 的额外字段由各自 schema
决定；无参 envelope 和 `settings.write` envelope 会拒绝未知键。

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
│  ├─ 处理 RPC dispatch (RPC[key] → handler)                     │
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
- 唯一被串行化的是**对同一个 session 的并发 turn**：sidecar 在 RPC 层按 `(workspace, sessionId)` 拒绝，返回 `session_busy`（见 2.8）。这是为了避免用户消息在同一对话分支上交错
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

### 2.5 Channel layer (IM)

```
┌─────────────────────────────────────────────────────┐
│ ChannelRegistry  (已加载的 channel 实例)              │
│  ├─ 每个 channelId 一个 Channel / ChannelHandle      │
│  ├─ ChannelBindBroker（状态 / 待验证的验证码）        │
│  └─ 每 channel 的 OutboundSink + 串行 push 链         │
└─────────────────┬───────────────────────────────────┘
                  │ 1:N 跟踪
┌─────────────────▼───────────────────────────────────┐
│ WorkspaceRuntime (im:// 路径)                         │
│  ├─ NodeExecutionEnv 位于 $TACO_HOME/sessions/im/…/   │
│  ├─ ConversationRouter（peer/chat → session）         │
│  ├─ ImWorkspacePolicy（per-channel 默认值 + chat 覆盖）│
│  └─ fs 工具被禁用（IM_DISABLED_FS_TOOLS）              │
└─────────────────────────────────────────────────────┘
```

channel 层与常规 workspace 层是**相互独立**的：IM workspace 使用虚拟的
`im://` cwd，共用同一个 `SidecarServer`，但拿到的是一个单独且关掉了 FS
工具的 `WorkspaceRuntime`。IM 策略叠加在全局 command permission broker
与 per-channel 默认值之上：`commands.mode` 与全局同为手动 / 自动审批并替换全局模式，
`commands.allow` / `commands.deny` 追加到全局白名单 / 黑名单之后。

### 2.6 配置加载

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
- `commandPermissions` — `{ mode: "ask" | "auto", allow?: string[], deny?: string[] }`；黑名单命中需要审批且优先于白名单，未命中在 `ask` 模式审批、在 `auto` 模式自动通过。内置黑名单（递归强制删除、`git reset --hard`、强推、发布、上传、基础设施销毁）在两种模式下都要单次审批，白名单无法覆盖。白名单通配符按复合命令中的每条命令分别匹配，只有完全相同的规则才能放行整段文本。执行其他命令的命令（`eval`、`xargs`、`nohup` 等）除非被完全匹配放行，否则需要审批。`ask` 模式下严格只读的 Git 查看命令免审批。没有 `allow` 时旧 `rules` 按白名单读取。`allowedDirectories` 在工作目录之外追加 `cd` 可进入的绝对路径根。
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

### 2.7 MCP 工具动态接入

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

### 2.8 Daemon 作用域与租户隔离

sidecar 两种运行模式的隔离语义不同：

- **stdio 模式** —— 每个客户端独占一个 sidecar 进程，生命周期跟父进程绑定。
  租户隔离 = 再起一个进程。
- **daemon 模式** —— sidecar 作为常驻进程绑定到唯一的 control socket
  （Unix: `<runtime>/sidecar-ctl.sock`，Windows: `\\.\pipe\taco-sidecar-ctl-<slug>`）。
  control socket 同时也是单实例锁：在同一 control endpoint 上重复
  `taco start` 会复用既有 daemon，不会拉新进程。
  因此 daemon 模式下的租户隔离是「换 control endpoint」，不是「再起一个进程」。
  每次 `taco start` 之前 export 不同的 `TACO_RUNTIME_DIR`，
  Unix 上 data + control socket 落在不同目录，Windows 上 pipe slug
  从该目录派生，debug / release 不会抢同一条全局 pipe。

一个 daemon 内只有一个 `SidecarServer`，统一持有工作区注册表、会话、
命令去重闸门、渠道和带序号的事件日志。调度器也调用同一个运行时。
`ConnectionServer` 只持有传输、初始化状态和客户端能力；RPC 响应仅返回
发起连接；普通文件系统和 IM 工作区的 push（包括会话事件和权限请求）均广播给
所有已初始化的客户端。定时任务在桌面连接时也可以等待桌面审批；没有交互客户端
时直接拒绝审批请求。断开连接不会终止会话或销毁工作区。

`WorkspaceRegistry` 按 key 管理 starting、ready、closing 状态。并发构建
共享结果；关闭中的实例不再对新请求可见，新请求等待关闭完成后重建。
构建期间被失效的实例会释放资源；关闭 daemon 时禁止新建，并尝试关闭所有
资源，即使其中一个失败也继续清理。

所有配置写入经过 `ConfigStore` 事务。带 owner token 的跨进程锁覆盖读取、
集合修改和原子替换；活进程的锁不会因过期被抢占，竞争等待上限为一秒。
读取能发现其他进程的原子替换。重连及访问工作区时按 CLI 覆盖优先级重新解析
配置，只应用发生变化的派生状态。可热更新字段保留正在运行的会话；MCP、记忆、
系统提示词和默认思考级别在工作区构建时确定。新建工作区使用更新后的默认值，
现有工作区保留原配置，直到显式释放后重建或重启 daemon。配置刷新和 MCP 配置
写入均不会在请求路径上销毁工作区。渠道和扩展变化仍需要重启 daemon。

服务端提示当前以已渲染文本随共享 push 发送：语言取自触发请求的客户端，IM
入站没有客户端请求上下文时默认使用英文，尚未按每个接收方分别本地化。

不同工作区、不同 session 可并发运行。`CommandIdempotencyGate` 按
`(workspace, sessionId)` 限制同一会话的 turn 命令，并跨连接去重重试。

## 3. 客户端

### 3.1 客户端分层

`@taco-ai/protocol` 提供类型、常量与 TypeBox schema；`@taco-ai/shared`
提供浏览器安全的 facade 和 dispatcher。Node transport 通过 `/node` 单独
导出，桌面 transport 位于 `clients/taco-desktop/src/lib/clients/tacoClient.ts`。

### 3.2 `@taco-ai/shared` 设计要点

`TacoClientBase` 拥有帧缓冲、dispatcher、订阅和 typed facade 注入。
Node `TacoClient` 提供子进程传输、`start()` / `dispose()` 和检查版本的
`handshake()`；桌面 `TacoClient` 提供 Tauri transport 与重连处理。

`createTypedRpc(dispatch)` 将便捷参数组装为 wire envelope，
`createContractDispatch` 根据契约检查方法、参数、结果与路由：

- `call(method, workspace, params)`：workspace scope。
- `callProcess(method, params)`：process scope。

客户端 scope 与服务端 `ensureWorkspace` 独立；生命周期与 association resolve
调用不要求已有 runtime。jobs facade 使用 `createProcessContractDispatch`，
`config.patch` 面向模型/内部调用。

`FrameDispatcher` 先用布尔 `ok` 识别 response，再按 `id` 配对 pending 请求。
其余带字符串 `method` 的帧作为 push 分发，即使它有与请求相同的 id。
无法识别的帧发出 warning。

### 3.3 `@taco-ai/desktop` Tauri 骨架

桌面端连接的是 **sidecar daemon**，不是 UI 持有的 stdio 子进程。
daemon 生命周期由 `cli` 包与操作系统服务注册（如适用）共同管理；
桌面端只负责 attach 到 data socket 并在断连时自动重连。

- **Rust 后端 (`src-tauri/src/lib.rs`)**：
  - `workspace_ensure(cwd)` — 连接共享 sidecar daemon 的 NDJSON socket
    （或预热一个）；幂等。桌面端不拉子进程、不走 stdin/stdout。
  - `workspace_send(cwd, line)` — 把单条 NDJSON 帧写到 daemon 的 data socket。
    `cwd` 仅为 API 兼容；sidecar 按协议里的 `params.workspace` 路由。
  - `workspace_dispose_all()` — 断开桌面端的 socket 连接；daemon 继续运行，
    直到托盘 Quit 或 `taco stop` 主动请求关闭。
    完整的桌面端退出契约见 `clients/taco-desktop/README.md` 的
    **Lifecycle: close ≠ quit** 一节。
  - `set_fs_scope(path)` — 授予 FS plugin 路径访问
  - `desktop_config_read` / `desktop_config_write` — 读写 `~/.taco/desktop.json`
    （桌面端拥有的唯一文件）
  - `default_workspace_dir` — 返回 `$TACO_HOME/workspace/` 并按需 `mkdir -p`
  - `paths_are_dirs` — 批量存在性检查（用于 sidebar 本地存储中
    失效 cwd 的剪枝）
  - 把每条收到的 NDJSON 帧转发为 Tauri 事件 `sidecar-event { line }`
  - socket 断开时发出 `sidecar-exited { code?, reason? }`，让 client
    拒绝所有 pending RPC 并启动有界重连

- **React 前端 (`src/`)**：
  - `lib/clients/tacoClient.ts` — 在 Tauri transport 上的 typed `TacoClient`，
    持有桌面端 README 描述的 reconnect 状态机
  - `App.tsx` — workspace sidebar + session list + chat pane + settings
    + plugins + skills + agents + channels + memory panes；共用一套状态机

**Rust 侧的坑**（值得留意）：

- `#[tauri::command] async fn` 拿到的是 `State<'_, ...>`。持锁跨 `.await`
  会死锁。写法是：在 `lock()` 里把需要的 `mpsc::Sender` clone 出来，
  释放锁，再 `send().await`。

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

### 4.3 IM 通道的一次往返

```
IM 对端          Channel SDK          sidecar                       桌面端
  │                  │                │                            │
  │── 文本消息 ─────>│                │                            │
  │                  │──onMessage──>  │                            │
  │                  │                │──ConversationRouter.route()│
  │                  │                │  (peer/chat → sessionId)   │
  │                  │                │                            │
  │                  │                │──ingress.submit() (RPC)────>│
  │                  │                │  session.prompt (im cwd)   │
  │                  │                │                            │
  │                  │                │<─push: session.event ──────│
  │                  │                │  message_start / update…   │
  │                  │                │                            │
  │                  │                │──channel.push(text)────────>│
  │                  │                │  extractReplyText + 分片   │
  │                  │                │                            │
  │<─ 回复文本 ──────│<─sdk.send()────│                            │
  │                  │                │                            │
  │                  │                │<─push: im.tools_enabled ───│  （仅首次）
```

sidecar 的 channel handle 在 `push` 时用 `extractReplyText` 抽取 assistant
文本（跳过 thinking 块、tool call、tool result），按渠道的单条消息长度预算
分片，再调 SDK 的 `send`。反向的请求流（扫码、配对码）走
`ChannelBindBroker.requestScan` / `requestVerifyCode`，它们会发布
`channel.status_changed` push 帧，让桌面端能实时渲染绑定 UI。
