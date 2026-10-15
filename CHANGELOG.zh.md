# 更新日志

Taco 所有值得注意的变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目自 `v0.1.0`（首次开源发布）起遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## \[0.2.9] — 2026-10-16

子代理可以跑进你自己的 Claude Code CLI 里，决定它干什么活的 agent 可以
在桌面上直接写，而在干活的会话不再显示为已结束。

### 新增

**子代理的第二种运行方式。** 标为 `claude-code` 的 agent 会把工作交给
你已经装好、已经登录的那个 `claude`，而不是关在 taco 里跑。工具集和权
限方式由你按 agent 配置，进度实时显示在面板上。

**可以在桌面里编辑的 agent。** agents 面板现在能创建、编辑和删除 agent
定义——不用再手写文件——保存后立刻在每个开着的 workspace 生效，无需重
启。如果一个 agent 只是套工具、本身没有角色，现在可以明确声明，而不是
留一段空 prompt。

**自己会打开的面板。** 这一轮触发了子代理或启用了任务列表时，任务与子
代理面板每次 run 会自己打开一次，不必再去找它们。重新打开一个本来就在
跑的 session 则不会打扰你。

### 变更

**一套视觉语言。** 界面现在是一个完整的设计，而不是一堆各自拼起来的面
板。

### 修复

- 仍在工作的会话不再显示为已结束。跑到一半切走再切回来、或者在别的会话
  正忙时开新会话，都会把还在跑的会话标成已停止，尽管它其实一直在继续。
- CLI 不再接管别的安装的 daemon。当另一个 checkout 或 bundle 的 daemon
  还在跑时启动 taco，之前会悄悄把它杀掉，于是你连上的是旧构建，却没
  有任何提示；现在它会告诉你挡路的是什么、该怎么处理。

## \[0.2.8] — 2026-10-14

一次以可靠性为主的版本：agent 不再被告知并不存在的工具，不再在自己的
自动压缩上死锁，也不会再用带 `~` 的路径绕过权限闸门。删除会话现在会
连带删除它的子代理。

### 新增

**用 `write` 直接写全局 skill 与 agent。** 在本地主 session 中，`write`
现在可以直接写 `$TACO_HOME/skills/` 与 `$TACO_HOME/agents/`，不再触发
权限询问——装一个 skill 不必再绕道请求一次已批准的 shell 命令。

### 变更

- prompt 不再宣称 harness 并不具备的能力：描述了并不存在的 `edit` 参数、
  实际并不强制的先读后改、catalog 里没有的工具，以及把并发执行的工具
  调用说成串行。
- 子代理不再拿到 `agent`、`askUser`、`planEnter` 与 `planExit`，不会再
  问出一个它根本没有渠道送达的问题。
- 桌面外壳收敛成一套：各面板现在共用表面层次、标题对齐，以及按钮与弹
  窗基元。
- Pi 从 `0.86.1` 升到 `0.99.2`，这是 Pi 1.0 把 agent harness 移出
  `pi-agent-core` 之前的最后一个版本。内置的 OpenRouter 目录少了 16 个
  模型 id，`defaultModel` 指向其中之一现在会没有默认模型可用。
- `session.delete` 现在对每个被删除的 session id 各发一帧 `session.deleted`，
  而不只是目标那一个。

### 修复

- 权限闸门不再被 `~`、`@` 与 `file://` 路径绕过：`write ~/.zshrc` 之前
  能通过工作区包含检查，因为路径是在 pi 展开之前比较的。
- 自动压缩不再死锁。从 idle-owner 回调里排的压缩任务会等它自己已持有
  的那把锁，超过阈值的会话因此挂住而非压缩。
- 停止 shell 命令时，它启动的进程也一起停。残留的孙进程可能占住 stdout，
  让工具调用永久卡住；POSIX 上现在按进程组整体发信号。
- 删除会话时会连带删除其子代理：`session.delete` 现在级联覆盖整棵会话
  树，而不是把每个会话的任务存储与结果遗留成孤儿。

## \[0.2.7] — 2026-09-23

子代理成为后台常驻角色：不再阻塞当前轮次，可以单独停止，结果也不会再因
重启而丢失。

### 新增

**后台子代理。** 子代理的工具调用返回后仍会继续运行，完成后再把结果送回来。
桌面端面板新增 Stop 按钮，可以取消某一个后台子代理；即便 sidecar 重启、
或父会话没能及时重新打开去接收实时通知，子代理的结果现在也能正常拿到。

### 变更

**降低重复轮次的成本。** 实时上下文信息改以不再导致每轮都撞上 provider
prompt 缓存失效的方式拼入 prompt。子代理卡片的状态显示也更准确——完成前被
中断的子代理会显示为错误，而不是看起来悄悄地完成了；已结束的卡片也不会再
卡在"运行中"。

### 修复

- 捕获或忽略 `SIGTERM` 的 shell 命令不再无限期挂住工具调用，连用户主动取消
  都能生效。
- `memory` skill 在整个对话过程中持续可用，不再只在第一次使用后就被丢弃。
- 已成功执行的子代理不会再被一次送达环节的小故障覆盖成失败。
- 使用自定义 `TACO_HOME` 时，会话 / 子代理预览现在能正常打开；之前会静默失败
  且没有任何报错提示。

## \[0.2.6] — 2026-09-20

会话标题改为摘要而非截断的首条消息，两处 prompt 缓存修复降低了长会话成本。

### 新增

**由 LLM 摘要派生的会话标题。** 标题带有来源信息（占位截断 → LLM 摘要 →
手动重命名），每次运行结束后会重新生成摘要，并通过新增的 `session.renamed`
事件实时推送；手动重命名是终态，之后的摘要不会再覆盖它。标题栏同时新增语言
与主题快捷菜单。

### 变更

Tauri 客户端的 Rust CI（clippy 与 `cargo test`）现在每个 PR 都会跑，不再只
在打 release tag 时才跑。

### 修复

- 手动 Compact 改按当前用量计算，不再套用自动压缩的预算；远低于自动阈值的
  会话不会再保留全部内容并生成空摘要。
- Skill 热重载不再重建逐字节相同的系统提示词，空操作的重扫描不再让此后挂载的
  每个会话都撞上一次 KV 缓存失效。

## \[0.2.5] — 2026-09-19

子代理运行实时流式进度并可恢复，压缩改由 sidecar 生命周期端到端驱动。

### 新增

**子代理进度流式输出 + 可恢复的子会话。** 子会话一创建就发布持久化的恢复
句柄，实时的 turn 更新会并入运行中的工具卡片——被中断的 `agent` / `skill`
调用可以通过 `agentContinue` 恢复，桌面端也能在运行过程中打开子会话。
context 用量环上还新增了 Compact 按钮，可在低于自动阈值时主动触发
`session.compact`。

### 变更

pi 0.85 去掉了旧的 compact 前后 hook，压缩现在由 sidecar 直接管理 start/end
配对，为每条路径根据用户阈值推导设置，并收拢为单次 LLM 调用。子代理进度改
从 `turn_end` 读取，不再重读子会话分支。`explorer` / `reviewer` 使用的只读
git 查看类命令（`git blame`、`git rev-parse`、`git ls-files`、
`git merge-base`、`git describe`，以及 dual-use 命令的只读形式）自动放行，会
改动状态的同族命令仍然需要确认。

### 修复

- 被 pin 的 skill 现在能在压缩后存活：冒号形式的 `<skill_body:NAME>` 不是合法
  闭合的 XML，pin、TUI 隐藏与 reinjector 都看不到它，现改为 XML 属性并按
  name 去重。
- 子代理会话不再被当成顶层会话出现在聊天列表中；列表改按最后一条用户可见消息
  排序，升级后不会再把所有旧会话都标成"刚刚"。
- 子代理面板消息不再继承主聊天区的外边距。

## \[0.2.4] — 2026-09-17

文件预览开始识别格式，Windows 安装器也不再踩到运行中的 daemon。

### 新增

**文件预览支持 HTML。** preview 弹窗内联渲染 HTML，新增"在系统浏览器打开"
入口，路径到浏览器的往返不再需要跳出应用或手抄路径。debug dock 也改为可
拖拽，子代理面板新增 message meta 行。

### 变更

工具卡片布局支持按 tool 单独覆写，单个 tool 的怪异区域可以单独重塑而不污染
其他 tool 的默认；默认 summary 去掉 JSON 尾巴，工具卡片先以散文呈现。skill
加载 / 热重载 / extension 诊断日志统一收口到同一个 helper。

### 修复

Windows 安装器在覆盖 `.exe` 前先请求 daemon 关闭，长时间运行的安装不会再
留下陈旧或半更新的 sidecar。

### 安全性

updater 不再内联原始 `.pub` 字节，构建时嵌入整个文件的 base64；被篡改或截断
的公钥在所有平台一致失败，不再按架构静默差异。

## \[0.2.3] — 2026-09-16

子代理获得一等公民侧边面板，sidecar 的派生状态不再在构造时被固化。

### 新增

**子代理侧边面板。** 右栏在现有 Tasks / Files 抽屉旁新增 subagent 面板，
agent card 作为入口，右栏宽度可拖拽；面板列表直接从消息流派生，跟源同步
无需按源失效。sidecar 侧，未知工具接到绝对路径会在 fence 处被拒；compaction
的取消请求不再被悄悄丢弃。

### 变更

长生命周期 consumer 改为接收 `resolveX: () => X` thunk，不再持有 mutable
config 快照；按名比对的守卫确保稳态 prompt 字节一致，模型 KV-cache prefix
不抖动。sidecar 内部 runtime 按关注点拆分，所有"等异步能力"接口统一走
`withDeadline`。`WorkspaceId` / `SessionId` / `ToolCallId` 品牌化，跨模块传错
ID 在编译期就报错。右栏互斥显示收成一个状态源。

### 修复

- `SubagentPanel` 挂到 `SubagentProvider` 内部，上下文稳定；拖拽时右栏宽度
  保持在合理区间，不会被压成零或推出屏外。
- Sidecar 重启后 push 序号续号，reconnecting 客户端不再因序号 gap 误判丢消息。
- Onboarding 改由 settled flag 触发，不再因临时非空 `cwd` 误触发。

## \[0.2.2] — 2026-09-14

运行中插话走上 wire，定时任务也给出诚实的运行回报。

### 新增

**插话与续接。** `session.steer` 向进行中的 turn 注入消息，
`session.followUp` 排队一个在 turn 结束后执行，`session.cancelQueued` 撤销
已排队的续接。协议升至 2.1，`session.steer` 返回 `{ mode, entryId }`，避免
2.0 daemon 被误读成成功入队。定时任务同时获得运行上限：`max_runs` 限制已接受
触发次数，`max_consecutive_failures` 是熔断器，耗尽后记录原因并解绑定时器。

### 变更

工作区在每轮 turn 起始重建工具集并合并到 session 活跃集合，策略 / IM / 扩展
变更无需失效刷新，下条消息即可生效。

### 修复

- `runNow` / `runJob` 返回 `JobRunResult { status, error }`，"ok" 仅代表触发被
  *接受*，不代表 turn 完成。
- 在所属 IM 会话内被 force-fire 的任务，`session.prompt` 被 busy 拒绝时降级为
  排队的续接，不再自死锁。
- 附着时回齐 session 活跃工具白名单，可重试候选项豁免。
- `officecli` skill 目录随 desktop 打包，免去额外拉取。

## \[0.2.1] — 2026-09-11

两个新内置 skill、手动重启 sidecar、更宽的只读白名单。

### 新增

- **`officecli`** 以内置扩展的形式随 sidecar 打包：skill 与放行规则由同一扩展
  提供，`officecli` 的 shell 命令在内存中被放行，Office 文档工作流不再逐条
  弹窗；禁用该扩展时两者一并消失。
- **`taco-configure`** —— 除 skill 写作之外的总入口，覆盖远程 skill 安装、
  agent 写作，以及 `$TACO_HOME/taco.json` 的原子补丁。
- **Settings → 应用** 中可手动重启 sidecar，免去开终端跑
  `taco stop && taco start`。
- 决策统一走 `askUser`，不再用正文提问；命令被拒绝后不再通过其他路径达成
  同一目标。

### 变更

read-only 白名单扩到日常 shell 工具箱——文件查看、文本检索、哈希，以及带安全
谓词的 `find`；会写文件或起进程的 `find` 谓词仍触发 ask 闸。

### 修复

- files drawer 切换按钮在新聊天欢迎页仍然可见，drawer 内图片改为内联预览。
- `channels.list` 与 `channels.create` 视图统一。
- `{subagent_delegation}` 占位符不再泄漏到渲染后的系统提示。

## \[0.2.0] — 2026-09-10

sidecar 统一升级到 Pi 0.85.1 并进入长驻 daemon 模型，桌面端常驻系统托盘。

### 新增

- **Pi 0.85.1 迁移。** 流式输出恢复（sidecar 把新的每条 message 负载字段镜像
  回旧字段）；带 `terminate: true` 的 `toolResult` 成为合法的收尾回复，不再是
  role mismatch；sidecar 重启会恢复被打断的运行并记录结束原因。
- **Daemon 监管入口。** `cli` 包升级为一级入口（`start` / `status` / `stop` /
  `install` / `uninstall` / `upgrade`）；release 构建首次启动会尝试执行
  `taco install`，在 macOS 注册 LaunchAgent、Windows 注册 Task Scheduler 任务。
- **桌面端常驻系统托盘。** 系统托盘入口、单实例窗口，生命周期为「关闭按钮仅
  隐藏到托盘、Quit 才真正退出」。
- 首次启动、切换 workspace、sidecar 重启后落入居中 logo + 中英文标语轮播的
  欢迎页；聊天列表改为「Chats / 聊天列表」并统一行高，session bar 新增任务
  面板切换按钮与未完成感知点，上下文指示器移入输入行。

### 变更

wire 工具事件改名为 `tool_start` / `tool_update` / `tool_end`；`LaneBusy` 由
抛出的 `AgentHarnessError` 改为 tagged error；`CreateSessionResult.assistantMessage`
放宽为 `AgentMessage`。README 增加未签名 macOS / Windows 二进制的首次启动说明，
并恢复 `pnpm release-age` 闸以配合 Pi 升级。

### 修复

- 子代理深度改从 `session.facts` 读取，消除旧 `cwdDepth` 启发式在 fork 上的
  静默错路由。
- 历史行不再被改写为加载时间，侧栏显示真实的最后活跃时间。
- 无回复 prompt 会暴露真实原因——model_unavailable、hook decline、abort。
- `one-shot` session handle 在完成后关闭，无残留 socket 保活、无僵尸子进程。
- 调度器 attach pin session 时不再覆盖用户的 `imRouting` 转发路由。

### 移除

清理 sidecar 的 5 个 dead export；保留的 1 个导出以 `@internal` JSDoc 标注并
通过 `knip` 追踪。

## \[0.1.3] — 2026-09-04

Mermaid 渲染、WeCom 渠道，以及一个 LLM dump 开关。

### 新增

- Mermaid 代码块默认渲染为流程图，header 切换按钮切回源码视图。
- WeCom aibot 渠道，支持凭据绑定流程与加固的重连生命周期。
- Debug tab 新增 `llmDumpToFile` 开关，将 `[taco:llm]` 行同步写入
  `$TACO_HOME/logs/llm-dump.log`。
- Plan 模式指令与 explorer 子代理提示模型在复杂追踪时输出 `flowchart` /
  `sequenceDiagram`。

### 变更

代码块语言标签通过 shiki transformer 端到端透传到 header；`settings.write`
广播到 daemon 内全部 `SidecarServer`，子进程无需重启即可收到更新。

### 修复

过期代码的 daemon 通过 ping/pong 的 `sidecar_version` 判定后被回收而非复用；
NSIS 安装包 preinstall 钩子在升级前清理残留 sidecar 守护进程。

## \[0.1.2] — 2026-09-01

fork 上下文的子代理，以及无需重启即可生效的配置变更。

### 新增

- `context: fork` 子代理能力，通过 frontmatter 驱动 hints。
- Agent tool hints 由 `AgentDefinition` 派生；reviewer 内置走 `context: fork`。

### 变更

`AgentSpawner.prepareChildAttach()` 在 spawn 与 resume 路径共用；测试集合理顺
（dedupe 与 logger 合并、checkpoint store 与 manager 合并、删除陈旧用例）。

### 修复

- `mcp.*` 变更无需重启 sidecar。
- 子代理的 `parentInstructionsBlock` 快照改为 lazy thunk。
- `stderrTee` dispose 时移除 error 监听。

## \[0.1.1] — 2026-08-27

开源之后的第一个版本区间：daemon 模式、调度器，以及桌面端自动更新。

### 新增

- **daemon 模式** 由 launchd / schtasks 托管，新增 CLI `upgrade` 子命令。
- **调度器与作业系统**，配套桌面 Schedules UI。
- IM 消息路由到 pin 住的会话。
- `sidecar.pid` 升级为 JSON，reap 遵循 install id 判定本机 / 他机。
- 桌面自动更新走 `tauri-plugin-updater`。

### 变更

- 聊天 UI：内联代码、消息描边、侧栏持久化。
- 桌面启动加固：TCC 预热、`EPERM` 视为已授权、打包 CSP 允许 WASM、工作区
  列表持久化。
- sidecar 可靠性：登录 shell `PATH` 缓存、Windows `atomicWrite` 容错 `EPERM`、
  出站请求带版本号。
- 跨平台稳定：全仓库 LF 行尾、pnpm-lock 跨 macOS / Windows 稳定。
- 调度器与共享层重构：统一 RPC 命名、作业生命周期加固、清理死代码；debug
  daemon 的 `$TACO_HOME` 与共享安装隔离。

### 修复

- `tauri:dev` 上反复出现的 "sidecar hello timeout" 与慢启动 kill-restart 循环。
- reap 路径区分本机 / 他机，wedged-daemon 仅杀自家，并兼容 dev 模式 launcher
  语义。
- Windows onboarding / runtime / 窗口标题栏；打包二进制不再弹出控制台窗口。
- 进程退出后遗留的 agent tool card 自动清理。

## \[0.1.0] — 2026-08-13

首次开源发布。sidecar 已经在内部使用数月；本版本是为公开发布所裁切。

### 新增 — 协议

初始化 wire 契约：强制 `initialize` 握手（v1.0），14 个 namespace 下共 54 个
RPC，以及 20 个 push 帧。

### 新增 — 运行时

初始化运行时：多 workspace / 多 session 路由、动态工具加载、子代理、Plan
模式、任务系统、记忆系统、Permission broker、IM 渠道、MCP 集成、Checkpoints、
项目上下文指令、IM workspace 策略。

### 新增 — 客户端

初始化客户端：`@taco-ai/protocol`、`@taco-ai/shared`、
`@taco-ai/debug-console`、`@taco-ai/desktop`（Tauri 2 + React），以及
`examples/python-cli/` 和 `examples/node-tui/` 示例。

### 新增 — 基础设施

初始化基础设施：`$TACO_HOME` 存储布局、`docs/` 文档集（含自动生成的协议文档）、
MIT 协议下发布的 npm 包 `@taco-ai/{protocol,shared,sidecar}`，以及桌面端
en + zh i18n。

### 安全性

初始化安全特性：安全的 config 视图、渠道凭证隔离、IM workspace 文件系统工具
隔离、Tauri 按 cwd 的 FS scope。
