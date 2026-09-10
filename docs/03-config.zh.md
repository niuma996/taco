# 配置指南

> 本文回答"如何配置 Taco"。

## 1. 安装

```bash
cd taco
pnpm install
```

`pnpm install` 一次性安装所有 workspace package（`@taco-ai/sidecar` + `@taco-ai/shared` +
`@taco-ai/desktop`）并把 pi-agent-core/pi-ai 从 npm 拉下来。

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

## 2. 模型配置

### 2.1 配置加载顺序（后者覆盖前者）

> 模型 key（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等）由 pi-ai 直接读
> process.env，不在 taco 的覆盖链里。taco.json 的 `apiKeys` 字段
> (`anthropic` / `openai` / 自定义 id) 会由 `injectApiKeysToEnv` 写回
> process.env，可作为 shell env 之外的兜底。

| 优先级 | 来源 | 覆盖谁 |
| --- | --- | --- |
| 1（最低） | 环境变量 `TACO_DEFAULT_MODEL` / `TACO_SESSIONS_ROOT` | — |
| 2 | **`~/.taco/taco.json`** | 配置文件 |
| 3（最高） | CLI 参数 `--default-model` / `--sessions-root` | config 文件 + 环境变量 |

### 2.2 global config：写 `~/.taco/taco.json`

默认路径 `~/.taco/taco.json`（`TacoGlobalConfigShape` schema）。
**不创建任何** **`.taco`** **目录。**

最小示例（只是声明默认 model，key 走 env var）：

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "systemPrompt": "Be concise."
}
```

完整示例（顺便把 key 也存到 config 里）：

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "systemPrompt": "Be concise. You are a helpful assistant.",
  "anthropicApiKey": "sk-ant-...",
  "openaiApiKey": "sk-...",
  "apiKeys": {
    "groq": "gsk-...",
    "deepseek": "sk-..."
  },
  "sessionsRoot": "/custom/path/to/sessions"
}
```

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
| `extra`           | object | 兜底，未来扩展用                                       |

### 2.3 没有 per-workspace config

跟 pi 保持一致——每个 cwd 的差异**不通过配置**表达，而是：

- session 数据按 cwd 隔离存放在 `~/.taco/sessions/<encoded-cwd>/`
- workspace 内模型/工具行为相同；如果有差异应该改 **session 内部的状态**（model\_change entry 等），不是配置文件

### 2.4 验证 config 链路

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