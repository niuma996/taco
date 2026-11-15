# Unreleased Release Notes

Draft for the next release; no version or release date has been assigned.

## English

### Improvements

- Strengthened the extension runtime with atomic rollback, workspace activators, lazy tools, and file-access declarations. `disabledExtensions` now also disables directory-discovered extensions; built-in file-access declarations cannot be overridden, and tool-name collisions or a broken candidate no longer take down a workspace or tool listing. — `sidecar` + `desktop`

## 中文

### 优化

- 增强插件运行时：支持原子回滚、工作区激活器、惰性工具和文件访问声明。`disabledExtensions` 现在也会禁用目录发现的插件；内置工具的文件访问声明不可被覆盖，工具重名或单个候选加载失败也不会再导致整个工作区或工具列表不可用。— `sidecar` + `desktop`
