# 配置指南

> 本文回答"如何配置 Taco"。

## 1. 安装

```bash
cd taco
pnpm install
```

`pnpm install` 一次性安装所有 workspace package（`@taco-ai/sidecar` + `@taco-ai/shared` +
`@taco-ai/desktop`）并把 pi-harness/pi-ai 从 npm 拉下来。

如果遇到 `Ignored build scripts` 警告，先去 `pnpm-workspace.yaml` 中允许：

```yaml
allowBuilds:
  '@biomejs/biome': true
  esbuild: true
```

### 1.1 系统服务注册（仅 release 构建）

非 debug 桌面端在首次启动时，setup 流程会自动执行 `taco install`
把 sidecar 注册成系统服务，使其在登出 / 重启后继续运行。CLI 在
首次启动时静默完成，不需要用户额外操作。

| 平台 | 注册方式 | 崩溃后自动重启 |
|---|---|---|
| macOS | LaunchAgent 写在 `~/Library/LaunchAgents/`，配 `RunAtLoad` | ✅（`KeepAlive`） |
| Windows | Task Scheduler 任务，系统启动时运行（`ONSTART`） | ❌（本版本未配置） |
| Linux | `taco install` 直接返回 `unsupported platform` | ❌ |

`taco uninstall` 会移除系统注册但保留用户数据（sessions、logs、
`~/.taco/`）。检查状态用 `taco status`，清理用 `taco stop` + `taco uninstall`。

Linux 用户若要 daemon-on-boot，需要自写 systemd user unit。`taco start`
本身在 Linux 上是可用的——只要用户登录，daemon 就一直跑。

## 2. 存储位置

Taco 会读 / 写下列文件路径。基准目录是 `$TACO_HOME`，默认 `~/.taco/`。

| 路径 | 归属 | 说明 |
|------|------|------|
| `$TACO_HOME/taco.json` | sidecar + desktop | 全局配置（`TacoGlobalConfigShape`）。权限 `0600`。 |
| `$TACO_HOME/desktop.json` | 仅 desktop | 安装引导状态、debug 开关。sidecar 不读。 |
| `$TACO_HOME/workspace/` | desktop | 桌面端没有 workspace 时的默认 cwd。首次启动时创建。 |
| `$TACO_HOME/skills/` | sidecar + 用户 | 全局 skill 扫描根目录。**本地主** session 可以直接用 `write` 写进去 —— 不触发权限询问、不需要退回 shell。IM 与 subagent session 拿不到这个权限。 |
| `$TACO_HOME/agents/` | sidecar + 用户 | 全局 agent 扫描根目录。同一条直写路径，同样的限制。 |
| `$TACO_HOME/sessions/<workspace>/<sid>.jsonl` | sidecar | 按 workspace 存放的 session transcript。 |
| `$TACO_HOME/sessions/im/<channelId>/<sid>.jsonl` | sidecar | 按 IM 渠道存放的 session transcript。 |
| `$TACO_HOME/sessions/<sid>/tasks/` | sidecar | 按 session 的 task store（与该 session 的 `.jsonl` 同处）。 |
| `$TACO_HOME/channels/<channelId>.json` | channel SDK | 渠道凭证。权限 `0600`。不放进 `taco.json`。 |
| `$TACO_HOME/checkpoints/<workspaceHash>/` | sidecar | turn 级的写前文件快照。`index.json` + 内容寻址的 `blobs/<sha256>`。 |
| `$TACO_HOME/im-workspace-policies/<channelId>.json` | sidecar | 按渠道的 IM workspace 策略（`imPolicy.*`）。 |
| `$TACO_HOME/work/` | sidecar | Work 记录、尝试、结果和投递状态。 |
| `$TACO_HOME/work-queue/` | sidecar | 定时与 IM 入站工作的持久执行意图。 |
| `$TACO_HOME/inbox/` | sidecar | IM 入站回执与冻结消息批次。 |
| `$TACO_HOME/vendor/` | sidecar + 用户 | 可选外部 SDK 安装。 |
| `$TACO_HOME/memory/projects/<source-key>/` | sidecar | 按工作区或完整 IM 对话身份存放主题记忆。 |
| `$TACO_HOME/logs/taco-desktop.log` | desktop | 轮转主日志（上限 10 MiB，保留 3 份，`0600`）。 |
| `$TACO_HOME/logs/llm-dump.log` | desktop | 可选的 LLM payload dump（仅当 `TACO_DEBUG_LLM_PAYLOAD=1` 且用户开启）。 |

`$TACO_HOME` 本身（也就是 `taco.json`）**不在**上面这份可写清单里：
它保存 API key 与 shell 权限规则，静默写入等于能绕过后续所有审批。

## 3. 模型配置

### 3.1 配置加载顺序（后者覆盖前者）

> 模型 key（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等）由 pi-ai 直接读
> process.env，不在 taco 的覆盖链里。taco.json 的 `apiKeys` 字段
> (`anthropic` / `openai` / 自定义 id) 会由 `injectApiKeysToEnv` 写回
> process.env，可作为 shell env 之外的兜底。

| 优先级 | 来源 | 覆盖谁 |
| --- | --- | --- |
| 1（最低） | 环境变量 `TACO_DEFAULT_MODEL` / `TACO_SESSIONS_ROOT` | — |
| 2 | **`~/.taco/taco.json`** | 配置文件 |
| 3（最高） | CLI 参数 `--default-model` / `--sessions-root` | config 文件 + 环境变量 |

### 3.2 global config：写 `~/.taco/taco.json`

默认路径 `~/.taco/taco.json`（`TacoGlobalConfigShape` schema）。
工作区级 agents、skills 和计划仍可使用项目内 `.taco/`；该目录不存放全局 `taco.json`。

最小示例（只是声明默认 model，key 走 env var）：

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "systemPrompt": "Be concise."
}
```

完整示例（覆盖所有支持的字段）：

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "defaultProvider": "anthropic",
  "systemPrompt": "Be concise. You are a helpful assistant.",
  "anthropicApiKey": "sk-ant-...",
  "openaiApiKey": "sk-...",
  "apiKeys": {
    "groq": "gsk-...",
    "deepseek": "sk-..."
  },
  "sessionsRoot": "/custom/path/to/sessions",
  "thinkingLevel": "medium",
  "compaction": {
    "enabled": true,
    "threshold": 0.7
  },
  "commandPermissions": {
    "mode": "ask",
    "allow": ["git status", "ls *", "npm test *"],
    "deny": ["git push *", "rm -rf *"]
  },
  "customProviders": [
    {
      "id": "custom:abcd1234",
      "name": "Local llama",
      "api": "chatcomplete",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "models": [{ "id": "llama-3" }]
    }
  ],
  "providerExtraModels": {
    "minimax": [{ "id": "MiniMax-M3.1-Flash-Preview" }]
  },
  "providerHiddenModels": {
    "minimax": ["MiniMax-M2.7-highspeed"]
  },
  "mcpServers": [
    {
      "id": "dbx",
      "transport": "stdio",
      "enabled": true,
      "command": "node",
      "args": ["/opt/dbx/server.js"],
      "alwaysLoaded": ["query"]
    }
  ],
  "channels": [
    {
      "channelId": "example-personal",
      "manifest": { "name": "example", "version": "0.1.0" },
      "config": {}
    }
  ],
  "extensions": ["@taco/extension-foo"],
  "disabledExtensions": ["@taco/extension-bar"],
  "instructions": {
    "enabled": true,
    "files": { "claudeMd": true, "agentsMd": true, "designMd": false },
    "inheritToSubagents": true
  }
}
```

本地会话的自动审批模式在未配置 `commandPermissions.deny` 时，支持简单 Bash
`ls` 路径通配符，例如 `ls src/*.ts`、`ls src/*/`、`ls ./*`；裸通配符需放在
`--` 后，例如 `ls -- *`，以免文件名被解释成选项。仅支持普通 `*`、`?` 和字符集合，
不包括 `**`、花括号、扩展通配符或重定向。循环、变量展开、命令替换及 `xargs`
仍需审批；手动模式、IM、Plan 模式和只读子 agent 保持原有限制。
为防止通配符隐藏黑名单中的具体路径，配置了任何 deny 规则时，此项自动放行不生效。

支持的 key：

| Key               | 类型     | 说明                                             |
| ----------------- | ------ | ---------------------------------------------- |
| `defaultModel`    | string | 内置 catalog 里的 model id，例如 `claude-sonnet-4-5`  |
| `defaultProvider` | string | 例如 `anthropic` / `openai` / `groq`             |
| `sessionsRoot`    | string | `.jsonl` 持久化目录，默认 `~/.taco/sessions`       |
| `systemPrompt`    | string | 默认 system prompt                               |
| `anthropicApiKey` | string | 注入到 `ANTHROPIC_API_KEY` env                    |
| `openaiApiKey`    | string | 注入到 `OPENAI_API_KEY` env                       |
| `apiKeys`         | object | 其它 provider → key，注入到 `<PROVIDER>_API_KEY` env |
| `providerExtraModels`  | object | 内置 provider id → 追加模型列表，见下方「内置供应商的模型列表」 |
| `providerHiddenModels` | object | 内置 provider id → 从静态列表移除的模型 id         |
| `extra`           | object | 兜底，未来扩展用                                       |

### 3.3 safe view（`settings.get` / `settings.write` 返回的那份）

`TacoGlobalConfigView` 在跨过 IPC 边界之前会剥掉所有带秘密的字段：

- `anthropicApiKey` / `openaiApiKey` / `apiKeys` → `MaskedKey`（provider
  前缀 + 末 4 位）
- `mcpServers[i]` → 丢弃 `env`、`headers`、`command`、`args`、`url`、`cwd`
- `channels[i]` → 丢弃 `config`

单个 provider 的 key 可以通过 `providers.revealKey`（协议 2.2+）读回明文。
这是与磁盘上的信任边界保持一致，而不是放宽它：key 本来就以明文存在本机的
`taco.json` 里，能连上 sidecar socket 的进程也能读到这个文件。该方法每次只
返回一个 key 且不落日志；`settings.*` 的整体视图仍然脱敏。`mcpServers` /
`channels` 里的秘密没有明文出口，需要请用户重新输入。

### 测试供应商连接

`provider.testConnection`（协议 2.2+）通过与会话完全相同的 pi 流式路径发送
一条极短的对话请求，所以「通过」意味着 key、端点、协议、模型 id 四者一起可用
——这是 `provider.listModels` 做不到的：不少中转站能应答 `/models` 却拒绝对话，
或反过来。

两种参数形态：`{ providerId, modelId, apiKey? }` 用于已保存的供应商（key 默认取自
sidecar 内部存储，`apiKey` 可覆盖，因此在详情面板里输入但还没保存的 key 也能先测）；
`{ baseUrl, api, apiKey, modelId }` 用于新建自定义供应商。探测失败属于正常返回值而非
RPC 错误——`reason` 取值为 `auth` / `not-found` / `rate-limited` / `timeout` /
`network` / `error`，`message` 里带上游原文。

探测本身刻意压得很轻（一条极短请求、输出上限 16 token、不重试、20 秒预算），
但它是一次真实请求，会消耗 token。每次探测使用独立的 provider 集合，不会读写
workspace 的 catalog。

### 内置供应商的模型列表

内置 provider 自带 pi 的静态模型列表。下面两个字段在不分叉 provider 的前提下
编辑这份列表；两者都以内置 provider id 为 key（`custom:` 前缀的 id 会被拒绝
——自定义 provider 的列表在 `customProviders[].models` 里），写入时整对象替换：

| Key | 类型 | 说明 |
|---|---|---|
| `providerExtraModels` | `Record<id, { id, name?, contextWindow?, maxTokens?, input? }[]>` | 追加在静态列表之后，沿用该 provider 自身的协议与端点 |
| `providerHiddenModels` | `Record<id, string[]>` | 从 catalog 中移除的静态模型 id。设置界面仍以 `origin: "hidden"` 列出，方便恢复 |

两者相互独立：隐藏某个静态 id 不会连带删除同名的用户追加项。空数组会被拒绝
——请直接删掉该 key。这两个字段需要协议 2.2；旧版 daemon 写入时会丢弃它们。

`input` 若出现，取值为 `"text"` 和/或 `"image"`（省略表示仅文本）。
`customProviders[].models` 上有同一个可选字段。它需要协议 2.6；2.5 的 daemon
在 `settings.write` 时会丢掉该字段却仍然返回成功，保存的图片开关因此不会生效。

### 3.4 全局设置与配置来源

`taco.json` 仍为全局文件，没有工作区级 `taco.json`；工作区仍可在 `.taco` 目录下
保存 agents、skills 和指令文件。Agents 与 Skills 面板区分以下来源：

| 视图 | 来源 |
|---|---|
| 生效 | 选定目标的合并运行时目录，包含兼容的 Claude/Pi 来源。 |
| 全局 | Taco 管理的 `$TACO_HOME/agents` 或 `$TACO_HOME/skills`。 |
| 工作区 | 执行目录下的 `.taco/agents` 或 `.taco/skills`。 |
| 内置 | 安装包中的原始定义，包含已启用扩展提供的 skills。 |

选择配置目标不会切换当前聊天；显式来源视图可查看被其他层遮蔽的定义。Agent 编辑器
支持创建、编辑、移动、重命名和删除 Taco 管理的全局／工作区定义；内置与外部兼容
来源保持只读。工作区代理覆盖同名全局代理。兼容目录中的 skill 可出现在生效视图，
但不会因此进入 Taco 管理的来源视图。

关联目录按策略授予执行和文件访问范围，不会把其中的 agents、skills 或 MCP 配置
合并进当前目标。IM 对话没有可编辑的工作区 Agent 层。RPC 作用域及记忆继承规则见
[配置来源协议](sidecar-protocol.md)。

### 3.5 验证 config 链路

跑一次 sidecar 看 stderr 中暴露的路径：

```bash
cd packages/sidecar
echo '{"id":"1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}' | npx tsx src/index.ts
```

预期 stderr：

```
[sidecar] listening on stdio. sessionsRoot=~/.taco/sessions, agentConfig=~/.taco/taco.json
```

如果看到 `sessionsRoot=...~/.taco/sessions`、`agentConfig=.../taco.json`，说明
走的是默认路径。

## 4. CLI flags

```
taco-sidecar [--default-model <model>] [--sessions-root <path>]
             [--system-prompt <text>] [--thinking-level <level>]
             [--anthropic-api-key <key>] [--openai-api-key <key>]
```

| Flag | 对应的环境变量 | 默认值 |
|------|----------------|---------|
| `--default-model` | `TACO_DEFAULT_MODEL` | 无 |
| `--sessions-root` | `TACO_SESSIONS_ROOT` | `~/.taco/sessions` |
| `--system-prompt` | — | 无 |
| `--thinking-level` | — | `off` |
| `--anthropic-api-key` | `ANTHROPIC_API_KEY` | `process.env` |
| `--openai-api-key` | `OPENAI_API_KEY` | `process.env` |

## 5. 长期记忆

项目记忆以 Markdown 主题文件保存在 `$TACO_HOME/memory/projects/<workspace-key>/`；
用户级 `MEMORY.md` 提供共享上下文。项目主题的摘要会进入模型上下文，需要时再读取完整正文。

可以在记忆面板查看和编辑主题、检查已记录的来源会话，以及预览整理结果。
旧主题可能没有来源信息；删除来源会话会使该会话无法再打开，但不会删除记忆本身。
记忆整理支持归档和恢复，清空归档会永久删除对应的归档副本。

自动提取采取保守策略：对话没有包含有依据、值得长期保留的信息时，记忆可以不发生变化。
记忆更新与聊天历史独立，因此未提取新记忆不代表聊天记录丢失。

### IM 记忆来源

每个完整 `im://<channelId>/<peerId>/<chatId>` 身份都有独立主题分区，改变执行目录
不会把它与其他对话的记忆合并。IM 自动以只读方式继承关联工作区主题；渠道／对话
策略的 `memory.inheritManagedGlobal` 开关还可继承当前 sidecar 进程已注册的本地
工作区主题，排除已关联来源和其他 IM 分区。人工维护的 `MEMORY.md` 仍共享。

记忆面板会标记只读主题。模型上下文摘要包含 `memoryLayer`、不透明 `sourceId`
和 `id`，可通过 `memory` 工具的 `read` 动作或 `memory.read` RPC 获取完整正文。
来源引用不是文件路径，也不是授权；每次读取都会重新检查关联与继承开关。写入和
整理始终面向当前分区。旧共享 IM scratch 身份下的主题不会自动复制，请审阅后再
选择需要的笔记迁入对话分区。

## 6. 外部子代理配置

| 运行时 | 前置条件 | 运行配置 |
|---|---|---|
| Claude Code | 单独安装本地 `claude` CLI 和可选 Agent SDK，并配置可用凭据。 | 沿用用户 Claude 设置；Taco 暂无对应的应用内安装卡片。 |
| Codex | 在 Agents 页面安装固定版本 SDK；应用内安装需要 npm，找不到时按页面说明手动安装。 | 沿用 `$CODEX_HOME`（默认 `~/.codex`）下的配置；模型覆盖留空即继承。 |

Codex 状态区分安装与认证，自带凭据的第三方 provider 不需要 OpenAI 登录。沙箱、
审批策略和 cwd 属于代理定义；Taco 根据工作区和关联目录检查 cwd。编辑器会保留
Codex 定义中的通信 `tools`：`[]` 关闭 bridge 工具，省略则允许 `chatToAgent`
和 `listAgentSessions`。

两种运行时均保留原生会话身份用于续聊，和 Taco 显示历史分别管理。SDK 原生会话不
保证出现在原应用的聊天列表中，可见性可能受来源与工作目录影响。安装命令与保留
规则见 [Sidecar 运行时指南](../packages/sidecar/README.md#optional-dependencies)。
