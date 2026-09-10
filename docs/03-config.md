# Configuration Guide

> How to install Taco and configure the sidecar / desktop.

## 1. Install

```bash
cd taco
pnpm install
```

`pnpm install` resolves the workspace packages (`@taco-ai/sidecar`,
`@taco-ai/shared`, `@taco-ai/desktop`) and pulls
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and
`@modelcontextprotocol/sdk` from npm.

If pnpm reports `[ERR_PNPM_IGNORED_BUILDS]`, allow the build scripts in
`pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@biomejs/biome': true
  esbuild: true
```

### 1.1 System service registration (release builds only)

On the first launch of a non-debug desktop build, the setup flow runs
`taco install` to register the sidecar as a system service so it
survives logout / reboot. The CLI does this silently on first launch;
nothing more is required from the user.

| Platform | Registration | Auto-restart on crash |
|---|---|---|
| macOS | LaunchAgent in `~/Library/LaunchAgents/` with `RunAtLoad` | ✅ (`KeepAlive`) |
| Windows | Task Scheduler task that runs at system startup (`ONSTART`) | ❌ (not configured in this release) |
| Linux | `taco install` returns `unsupported platform` | ❌ |

`taco uninstall` removes the registration but leaves user data
(sessions, logs, `~/.taco/`) intact. Inspect state with `taco status`;
remove with `taco stop` and `taco uninstall`.

Linux users who need daemon-on-boot should write their own systemd
user unit. `taco start` itself works on Linux — the daemon will run as
long as the user is logged in.

## 2. Storage locations

Taco reads / writes the following filesystem paths. The base is
`$TACO_HOME`, defaulting to `~/.taco/`.

| Path | Owner | Description |
|------|-------|-------------|
| `$TACO_HOME/taco.json` | sidecar + desktop | Global config (`TacoGlobalConfigShape`). Permission `0600`. |
| `$TACO_HOME/desktop.json` | desktop only | Onboarding state, debug toggles. Not read by sidecar. |
| `$TACO_HOME/workspace/` | desktop | Default workspace cwd when the desktop has none. Created on first launch. |
| `$TACO_HOME/sessions/<workspace>/<sid>.jsonl` | sidecar | Per-workspace session transcripts. |
| `$TACO_HOME/sessions/im/<channelId>/<sid>.jsonl` | sidecar | Per-IM-channel session transcripts. |
| `$TACO_HOME/sessions/<sid>/tasks/` | sidecar | Per-session task store (colocated with the session's `.jsonl`). |
| `$TACO_HOME/channels/<channelId>.json` | channel SDK | Channel credentials. Permission `0600`. Not in `taco.json`. |
| `$TACO_HOME/checkpoints/<workspaceHash>/` | sidecar | Turn-scoped pre-write file snapshots. `index.json` + content-addressed `blobs/<sha256>`. |
| `$TACO_HOME/im-workspace-policies/<channelId>.json` | sidecar | Per-channel IM workspace policy (`imPolicy.*`). |
| `$TACO_HOME/logs/taco-desktop.log` | desktop | Rotating main log (10 MiB cap, 3 retained, `0600`). |
| `$TACO_HOME/logs/llm-dump.log` | desktop | Optional LLM payload dump (only when `TACO_DEBUG_LLM_PAYLOAD=1` and the user enables it). |

## 3. Global config (`taco.json`)

Model keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are read directly
from `process.env` by pi-ai and are not part of Taco's override chain.
Taco's own merge order for the fields it owns is:

1. Env: `TACO_DEFAULT_MODEL`, `TACO_SESSIONS_ROOT` (lowest)
2. `~/.taco/taco.json`
3. CLI flags `--default-model`, `--sessions-root` (highest)

The `apiKeys` map (`anthropic` / `openai` / custom provider id → key)
crosses both worlds: it lives in `taco.json` but is written back into
`process.env` via `injectApiKeysToEnv`, so it acts as a fallback for
shell env. See `packages/sidecar/src/config/config.ts` for the merge
implementation.

The full schema is `TacoGlobalConfigShape` in
`packages/protocol/src/config.ts`. The masked view that crosses the IPC
boundary is `TacoGlobalConfigView` (strips secrets; see "Safe view"
below).

### Minimal example

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "systemPrompt": "Be concise."
}
```

### Full example (every supported field)

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "defaultProvider": "anthropic",
  "systemPrompt": "Be concise. You are a helpful assistant.",
  "anthropicApiKey": "sk-ant-...",
  "openaiApiKey": "sk-...",
  "apiKeys": {
    "groq": "gsk-...",
    "deepseek": "sk-..."
  },
  "sessionsRoot": "/custom/path/to/sessions",
  "thinkingLevel": "medium",
  "compaction": {
    "enabled": true,
    "threshold": 0.7
  },
  "commandPermissions": {
    "mode": "ask",
    "rules": ["git status", "ls *", "npm test *"]
  },
  "customProviders": [
    {
      "id": "custom:abcd1234",
      "name": "Local llama",
      "api": "chatcomplete",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "models": [{ "id": "llama-3" }]
    }
  ],
  "mcpServers": [
    {
      "id": "dbx",
      "transport": "stdio",
      "enabled": true,
      "command": "node",
      "args": ["/opt/dbx/server.js"],
      "alwaysLoaded": ["query"]
    }
  ],
  "channels": [
    {
      "channelId": "example-personal",
      "manifest": { "name": "example", "version": "0.1.0" },
      "config": {}
    }
  ],
  "extensions": ["@taco/extension-foo"],
  "disabledExtensions": ["@taco/extension-bar"],
  "instructions": {
    "enabled": true,
    "files": { "claudeMd": true, "agentsMd": true, "designMd": false },
    "inheritToSubagents": true
  }
}
```

### Safe view (returned by `settings.get` / `settings.write`)

`TacoGlobalConfigView` strips secret-bearing fields before the value
crosses the IPC boundary:

- `anthropicApiKey` / `openaiApiKey` / `apiKeys` → `MaskedKey` (provider prefix + last 4 chars)
- `mcpServers[i]` → drops `env`, `headers`, `command`, `args`, `url`, `cwd`
- `channels[i]` → drops `config`

Clients that need the unmasked values must ask the user to re-enter them
or read from a different surface (desktop Tauri command `read_file`
or equivalent).

## 4. CLI flags

```
taco-sidecar [--default-model <model>] [--sessions-root <path>]
             [--system-prompt <text>] [--thinking-level <level>]
             [--anthropic-api-key <key>] [--openai-api-key <key>]
```

| Flag | Env counterpart | Default |
|------|----------------|---------|
| `--default-model` | `TACO_DEFAULT_MODEL` | none |
| `--sessions-root` | `TACO_SESSIONS_ROOT` | `~/.taco/sessions` |
| `--system-prompt` | — | none |
| `--thinking-level` | — | `off` |
| `--anthropic-api-key` | `ANTHROPIC_API_KEY` | `process.env` |
| `--openai-api-key` | `OPENAI_API_KEY` | `process.env` |

## 5. No per-workspace config

`Pi`-style: each workspace's differences are expressed through session
state, not through a per-cwd config file. The `taco.json` is global.
Workspaces are identified by absolute `cwd` paths; sessions are
identified by `uuidv7` ids. Tooling differences (e.g. available MCP
servers, IM policy) are per-session or per-workspace-runtime, not per-cwd
config.