# Unreleased Release Notes

Draft for the next release; no version or release date has been assigned.

## English

### Improvements

- Active and archived memory topics share a versioned YAML codec. Unmarked files
  keep their literal values; CAS checks read only the target file from disk.
  New writes keep canonical UTC timestamps and JSON provenance readable by older
  releases — `sidecar`
- Codex communication uses the existing MCP SDK in a standalone bridge, included
  in npm and portable-runtime builds with integrity checks — `sidecar`

### Fixes

- Preserve YAML date and numeric provenance identifiers; reject unknown codec
  versions and protect unreadable topic files from overwrite — `sidecar`
- Close relay resources on SDK transport shutdown and cancellation; support
  symlink entry paths and suppress development experimental warnings — `sidecar`

### Downgrade notes

- Back up `$TACO_HOME/memory` before upgrade and restore it before returning to a
  pre-codec release. Old readers retain YAML quote characters in special names
  and descriptions; old-version writes can permanently change those values — `sidecar`
- Early codec files with quoted timestamps and block YAML sources additionally
  lose provenance on old readers. Quoted archive ages fail `Date.parse`, so their
  retention cleanup is silently skipped. New writes avoid this timestamp/source
  incompatibility; reads do not rewrite existing files — `sidecar`

## 中文

### 优化

- 活跃与归档记忆共用带版本的 YAML codec，未标记文件保持字面值；CAS 检查仅从磁盘读取目标文件。
  新写入的标准 UTC 时间戳和 JSON 来源保持旧版可读 —— `sidecar`
- Codex 通信复用现有 MCP SDK，桥独立打包，随 npm 和便携运行时发布并检查完整性 —— `sidecar`

### 修复

- 保留 YAML 日期和数字来源标识，拒绝未知 codec 版本，防止覆盖不可解码的同名文件 —— `sidecar`
- SDK transport 关闭及取消时清理桥资源，支持符号链接入口路径，抑制开发模式实验警告 —— `sidecar`

### 降级说明

- 升级前备份 `$TACO_HOME/memory`，降至不支持 codec 的旧版前恢复该备份。
  旧版会将特殊名称/描述的 YAML 引号读入字面值，旧版再次写入可能固化这些变化 —— `sidecar`
- 早期 codec 文件若使用带引号的时间戳和块式 YAML sources，旧版还会丢失来源。
  带引号的归档年龄无法通过 `Date.parse`，清理会静默跳过这些归档。
  新写入已避免时间戳和来源的不兼容；读取不会重写已存在文件 —— `sidecar`
