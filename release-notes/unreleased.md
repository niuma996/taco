# Unreleased Release Notes

Draft for the next release; no version or release date has been assigned.

## English

### Improvements

- Strengthened the extension runtime with atomic rollback, workspace activators, lazy tools, and file-access declarations. `disabledExtensions` now also disables directory-discovered extensions; built-in file-access declarations cannot be overridden, and tool-name collisions or a broken candidate no longer take down a workspace or tool listing. — `sidecar` + `desktop`
- Added workspace/session extension lifecycles with completion events and deterministic cleanup, validated per-extension configuration, and diagnostics that distinguish runtime state from pending configuration changes. Toggled cards stay in their current Enabled/Disabled section with a pending chip until restart; load failures alone no longer trigger the restart banner. — `sidecar` + `desktop`

## 中文

### 优化

- 增强插件运行时：支持原子回滚、工作区激活器、惰性工具和文件访问声明。`disabledExtensions` 现在也会禁用目录发现的插件；内置工具的文件访问声明不可被覆盖，工具重名或单个候选加载失败也不会再导致整个工作区或工具列表不可用。— `sidecar` + `desktop`
- 新增工作区/会话插件生命周期、完成事件与确定性清理，支持独立配置校验，并在诊断中区分实际贡献和待重启状态。— `sidecar` + `desktop`
