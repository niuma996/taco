# 最小发布回归工具集

```sh
pnpm regression
pnpm regression --runtime packages/sidecar/dist/runtime/aarch64-apple-darwin
pnpm release:preflight
pnpm release:preflight --full
```

默认入口重新构建 protocol、shared 和本机平台 runtime，防止测到旧产物。
`--runtime` 严格验证指定产物，缺失时失败，不自动构建；CI 使用此模式复用构建结果。
该模式要求当前客户端的 `packages/protocol/dist` 已构建，用它校验协议握手。
`release:preflight` 默认只运行最小回归，`--full` 保留原有完整检查并增加最小回归。

固定检查四项：

1. runtime 目标平台、Node/JS 校验和、内置资源及 WASM 文件。
2. 仓库外、无 node_modules、临时 TACO_HOME 中启动自带 Node，control.ping 返回正确版本和 PID。
3. 数据通道 initialize 握手成功，协议版本与当前客户端一致。
4. control.shutdown 成功且进程以 0 退出。

启动等待最多 15 秒，单次 RPC 最多 3 秒，退出最多 5 秒；失败立即返回非零退出码并输出阶段和最近 stderr。
所有临时进程和文件由工具清理。产物复制与校验的耗时随磁盘而变，构建时间另计。

使用 Node 内置库，无新依赖，不运行全量单测、UI、模型请求、npm 消费者安装或升级测试。
此入口只证明打包 runtime 的启动链路可用，不表示全量业务回归通过，也不验证最终 DMG/NSIS 的安装过程。
CI 在 Linux PR 构建以及 macOS/Windows 发布构建中执行；任一步失败均阻止该构建完成。

仅当历史故障无法由这四项覆盖且会阻断基本使用时，才扩充必跑范围。
修改工具本身时运行 `node --test scripts/regression/runtime.test.mjs`。
