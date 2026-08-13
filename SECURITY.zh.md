# 安全策略

Taco 是基于 MIT 协议开源的软件。本项目**面向个人使用**——预期由单个
开发者在自己的机器上运行 sidecar 和桌面端。我们严肃对待安全问题，欢迎
协调披露。

## 报告漏洞

**请勿就安全问题开公开 GitHub issue。**

发送私密报告到 `niuma1024@outlook.com`。报告应包含：

- 问题的清晰描述与影响。
- 复现步骤（NDJSON 报文、沙箱日志或构建 hash）。
- 观察到的版本 / commit SHA。
- 是否打算公开披露，及时间表。

除非请求匿名，否则在 fix commit 和 CHANGELOG 条目中向报告者致谢。

## 威胁模型

Taco 是**面向个人使用的本地工具**——预期部署形态是单个开发者在自己的
机器上运行 sidecar 和桌面端。威胁模型以此为界：

- **本地 shell / FS 访问**：`NodeExecutionEnv` 在宿主机直接执行 shell 和
  FS 工具，sidecar 用户可触达进程能访问的所有文件。该信任边界与本机终端
  一致，对个人使用可接受；任何共享 / 多租户场景需要另行引入隔离层。
- **MCP 工具不受 permission broker 网关管控** — 在 `taco.json` 里加一个
  server 等于隐式授权其下每把工具，添加前请自行甄别。
- **API key** 存于 `$TACO_HOME/taco.json`（`0600`），同时以明文驻留在
  sidecar 进程内存并镜像到 `process.env` 给子进程。请把 `taco.json` 当
  凭据文件对待。
- **IM 渠道凭证** 存于 `$TACO_HOME/channels/<id>.json`（`0600`），
  与 `taco.json` 分离。
- **网络暴露**：v0.1.0 仅 stdio NDJSON；Tauri 用 localhost IPC，不监听
  网络端口。

## 不在范围内

- 上游依赖（`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、
  `@modelcontextprotocol/sdk`）的 bug — 请向对应项目报告。
- 用户主动添加的第三方 agent / skill / extension frontmatter 中的问题。