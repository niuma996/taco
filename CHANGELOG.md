# Changelog

All notable changes to Taco are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
starting with `v0.1.0` (the first open-source release).

## [0.1.0] — 2026-08-13

First open-source release. The sidecar has been in active use for several
months; this is the version cut for the public release.

### Added — protocol

Initial wire contract: mandatory `initialize` handshake (v1.0) plus 54 RPC
methods across 14 namespaces and 20 push frames.

### Added — runtime

Initial runtime: multi-workspace / multi-session routing, dynamic tool
loading, subagents, plan mode, tasks, memory, permission broker, IM channels,
MCP integration, checkpoints, project context instructions, and IM workspace
policy.

### Added — clients

Initial clients: `@taco-ai/protocol`, `@taco-ai/shared`,
`@taco-ai/debug-console`, `@taco-ai/desktop` (Tauri 2 + React), and the
`examples/python-cli/` and `examples/node-tui/` examples.

### Added — infrastructure

Initial infrastructure: `$TACO_HOME` storage layout, `docs/` set (including
the auto-generated protocol doc), MIT-licensed npm packages
`@taco-ai/{protocol,shared,sidecar}`, and en + zh i18n in the desktop client.

### Security

Initial safe-config view, channel credential isolation, IM workspace FS tool
isolation, and per-cwd Tauri FS scoping.