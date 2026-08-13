# 测试与调试指南

> 本文回答"如何跑通端到端验证 + 调试运行时问题"。

## 1. 端到端测试

### 1.1 Tier 1：协议层冒烟测试（无需 API key）

**目标**：验证 NDJSON 协议框架工作，不依赖 LLM 调用。

```bash
# Terminal 1
cd packages/sidecar
npx tsx src/index.ts

# Terminal 2
cd packages/sidecar
echo '{"id":"1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}' | npx tsx src/index.ts
```

期望 stderr/stdout 输出（顺序）：

```
{"id":"<uuid>","method":"sidecar.hello","workspace":"*","params":{"version":"0.1.0","pid":...}}
[sidecar] listening on stdio. sessionsRoot=~/.taco/sessions, agentConfig=~/.taco/taco.json
{"id":"1","ok":true,"result":{"cwd":"/tmp/x","sessionsRoot":"~/.taco/sessions"}}
```

**这是当前已经验证通过的最简链路。**

### 1.2 Tier 2：协议层完整测试（无需 API key）

```bash
{ echo '{"id":"1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}'
  sleep 0.3
  echo '{"id":"2","method":"session.list","params":{"workspace":"/tmp/x"}}'
  sleep 0.3
  echo '{"id":"3","method":"session.listModels","params":{"workspace":"/tmp/x"}}'
  sleep 1
} | npx tsx src/index.ts
```

期望：

- 三条响应都 `ok: true`
- `session.list` → `{workspace:"/tmp/x", sessions:[]}`（空 array 是首次运行）
- `session.listModels` → `{models:[...]}` 或空（视 API key 状态）

### 1.3 Tier 3：Node 客户端冒烟

`examples/node-tui` 启动时会用 `initialPrompt` 构造并 attach session，
后续是交互式 REPL。任何 LLM 调用都需要 API key——无 key 时报 auth
错是预期，本 tier 验证的是协议栈能跑通。

### 1.4 Tier 4：Node 客户端 E2E（需要 API key）

```bash
export ANTHROPIC_API_KEY=sk-ant-...

cd examples/node-tui
pnpm start /tmp/x
```

在 `taco>` 提示符输入一行文本。期望：

- 连上即收到 hello
- 收到 `session.event` push 时终端打 `[event] ...`（payload 被截到 120 字符，**不做** token 级流式渲染）
- 一轮完成后终端打印 `[response] ...`

### 1.5 Tier 5：E2E 流式增量验证（重点）

Node TUI 示例已经订阅 push 帧，并按 `session.event.message_update` 抽出 delta 文本。如果 LLM 真的在 streaming，应该能看到字符渐次出现（token-level updates）。

push 事件可能形态：

- `message_start`：消息开始（assistant 接到第一条 token）
- `message_update`：每收到 token 推送一次
- `message_end`：消息最终结束
- `turn_end`：一个 turn 结束
- `agent_end`：整个 run 结束

e2e.ts 已经被示例代码处理过，验证时观察 stderr 即可。

### 1.6 Tier 6：runtime 模型切换（API key 测试）

```bash
# 1. 启动 sidecar（带 API key）
export ANTHROPIC_API_KEY=sk-ant-...
echo '{"id":"1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}' | npx tsx src/index.ts

# 2. session.create + prompt (同 context)
echo '{"id":"2","method":"session.create","params":{"workspace":"/tmp/x","initialPrompt":"hi"}}' | npx tsx src/index.ts

# 3. session.listModels
echo '{"id":"3","method":"session.listModels","params":{"workspace":"/tmp/x"}}' | npx tsx src/index.ts

# 4. setModel 切换
echo '{"id":"4","method":"session.setModel","params":{"workspace":"/tmp/x","sessionId":"...","provider":"anthropic","modelId":"claude-haiku-4-5"}}' | npx tsx src/index.ts
```

> **注意**：每次 `npx tsx src/index.ts` 是新进程，所以 sessionId 不会跨进程持续。如果想做"切换前后对比"需要保留同一个 sidecar 进程。

### 1.7 Tier 7：Tauri 桌面端

```bash
cd clients/taco-desktop
# 准备 icon（必需）
# 可以从参考项目 desktop 拷 icon，或者临时用 PNG 占位
从其他 Tauri 项目拷 icon，或临时用 PNG 占位

# 启动开发
pnpm tauri:dev
```

Tauri WebView 打开后，左 sidebar 列 workspace + session，右侧 chat pane 显示历史 + 新 prompt 流。

> **还没做端到端验证**（缺 icon 文件以及完整的 Tauri dev 运行测试）。Rust 代码通过 `cargo check --offline`。

## 2. 调试技巧

### 2.1 抓 raw NDJSON

```bash
# 一次性看 stdout + stderr + 保存到 log
cd packages/sidecar
{ echo '{"id":"1","method":"workspace.ensure","params":{"cwd":"/tmp/x"}}' ; sleep 5 ; } \
  | npx tsx src/index.ts 2>&1 | tee /tmp/taco-log.txt
```

### 2.2 复现 push 接收端问题

`@taco-ai/shared` 的 `dispatch()` 区分 push vs response 的逻辑（priority: push first）：
详见 [`packages/shared/tacoClient.ts:147`](../packages/shared/tacoClient.ts)。

如果发现 push 帧被识别成 response（导致抛 `Cannot read 'message'`），检查：

1. id 字段：是 uuid 字符串且不是 pending Map 里的 key
2. method 字段：必填（push 必须有 method，response 不应该有 method）

### 2.3 看 session 实际写入的文件

```bash
ls -la ~/.taco/sessions/*/tmp/x/*.jsonl

# 读 .jsonl 看到原始 entry
cat ~/.taco/sessions/*/tmp/x/*.jsonl | head -3
```

### 2.4 重置 sessions

```bash
rm -rf ~/.taco/sessions
```

sidecar 不会自动清理过期 sessions。