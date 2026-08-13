# 更新日志

Taco 所有值得注意的变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目自 `v0.1.0`（首次开源发布）起遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

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
