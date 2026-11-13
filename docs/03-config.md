# Configuration Guide

> How to install Taco and configure the sidecar / desktop.

## 1. Install

```bash
cd taco
pnpm install
```

`pnpm install` resolves the workspace packages (`@taco-ai/sidecar`,
`@taco-ai/shared`, `@taco-ai/desktop`) and pulls
`@taco-ai/pi-harness`, `@earendil-works/pi-ai`, and
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
| `$TACO_HOME/skills/` | sidecar + user | Global skills scan root. A **local main** session may `write` into it directly — no permission prompt, no shell fallback. IM and subagent sessions do not get this. |
| `$TACO_HOME/agents/` | sidecar + user | Global agents scan root. Same direct-write path and same restrictions. |
| `$TACO_HOME/sessions/<workspace>/<sid>.jsonl` | sidecar | Per-workspace session transcripts. |
| `$TACO_HOME/sessions/im/<channelId>/<sid>.jsonl` | sidecar | Per-IM-channel session transcripts. |
| `$TACO_HOME/sessions/<sid>/tasks/` | sidecar | Per-session task store (colocated with the session's `.jsonl`). |
| `$TACO_HOME/channels/<channelId>.json` | channel SDK | Channel credentials. Permission `0600`. Not in `taco.json`. |
| `$TACO_HOME/checkpoints/<workspaceHash>/` | sidecar | Turn-scoped pre-write file snapshots. `index.json` + content-addressed `blobs/<sha256>`. |
| `$TACO_HOME/im-workspace-policies/<channelId>.json` | sidecar | Per-channel IM workspace policy (`imPolicy.*`). |
| `$TACO_HOME/work/` | sidecar | Work records, attempts, results and delivery state. |
| `$TACO_HOME/work-queue/` | sidecar | Durable scheduled and inbound execution intents. |
| `$TACO_HOME/inbox/` | sidecar | Inbound IM receipts and frozen message batches. |
| `$TACO_HOME/vendor/` | sidecar + user | Optional external SDK installations. |
| `$TACO_HOME/memory/projects/<source-key>/` | sidecar | Topic memory keyed by workspace or full IM conversation identity. |
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
    "allow": ["git status", "ls *", "npm test *"],
    "deny": ["git push *", "rm -rf *"]
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
  "providerExtraModels": {
    "minimax": [{ "id": "MiniMax-M3.1-Flash-Preview" }]
  },
  "providerHiddenModels": {
    "minimax": ["MiniMax-M2.7-highspeed"]
  },
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

Local automatic sessions also support simple Bash `ls` path globs when
`commandPermissions.deny` is empty, for example `ls src/*.ts`, `ls src/*/`, and
`ls ./*`. Bare patterns must follow `--` (`ls -- *`) so filenames cannot become
options. This supports ordinary `*`, `?`, and character classes, excluding
globstar, braces, extended globs, and redirects. Loops, variables, command
substitution, and command runners such as `xargs` still require approval.
Manual, IM, plan, and read-only execution retain their existing restrictions.
Any configured deny rule disables this allowance to avoid hiding a denied
literal path behind a glob.

### Safe view (returned by `settings.get` / `settings.write`)

`TacoGlobalConfigView` strips secret-bearing fields before the value
crosses the IPC boundary:

- `anthropicApiKey` / `openaiApiKey` / `apiKeys` → `MaskedKey` (provider prefix + last 4 chars)
- `mcpServers[i]` → drops `env`, `headers`, `command`, `args`, `url`, `cwd`
- `channels[i]` → drops `config`

A single provider key can be read back in plaintext with
`providers.revealKey` (protocol 2.2+). This keeps parity with the on-disk
trust boundary rather than widening it: the key already sits in plaintext
in `taco.json` on the same machine, readable by anything that can reach
the sidecar socket. The method returns one key per call and never logs it;
the bulk `settings.*` views stay masked. There is no plaintext surface for
`mcpServers` / `channels` secrets — re-enter those.

### Testing a provider

`provider.testConnection` (protocol 2.2+) sends one minimal chat turn through
the same pi streaming path a session uses, so a pass means the key, endpoint,
protocol and model id all work together — more than `provider.listModels` can
show, since many relays answer `/models` while rejecting chat, or the reverse.

Two param shapes: `{ providerId, modelId, apiKey? }` for a saved provider (the
key comes from the sidecar's store unless `apiKey` overrides it, so a key typed
in the detail panel can be tested before saving) and
`{ baseUrl, api, apiKey, modelId }` for the create-custom form. Probe failures
are a normal result, not an RPC error — `reason` is one of `auth`,
`not-found`, `rate-limited`, `timeout`, `network`, `error`, with the upstream
message in `message`.

The probe is deliberately cheap (one short turn, ≤16 output tokens, no retries,
20s budget) but it is a real request and costs tokens. Each probe runs in its
own provider collection and never touches the workspace catalog.

### Model lists on built-in providers

Built-in providers ship pi's static model list. Two fields edit that list
without forking the provider; both are keyed by built-in provider id
(a `custom:` id is rejected — custom providers own their list in
`customProviders[].models`) and replaced as a whole object on write:

| Key | Type | Meaning |
|---|---|---|
| `providerExtraModels` | `Record<id, { id, name?, contextWindow?, maxTokens?, input? }[]>` | Appended after the static list. They stream through the provider's own protocol and endpoint. |
| `providerHiddenModels` | `Record<id, string[]>` | Static ids removed from the catalog. The settings UI still lists them as `origin: "hidden"` so they can be restored. |

The two are independent: hiding a static id does not drop a user-added
entry with the same id. Empty arrays are rejected — remove the key instead.
Both fields need protocol 2.2; an older daemon drops them on write.

`input`, when present, is `"text"` and/or `"image"` (omitted means text only).
The same optional field exists on `customProviders[].models`. It needs
protocol 2.6; a 2.5 daemon drops it on write and still answers ok, so a saved
image switch would not stick.

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

## 5. Global settings and source layers

`taco.json` remains global; there is no workspace-local `taco.json`. A workspace
can still own agents, skills and instruction files under its `.taco` directory.
The Agents and Skills panes distinguish these source layers:

| View | Source |
|---|---|
| Effective | The selected target's merged runtime catalog, including compatible Claude/Pi sources. |
| Global | Taco-owned `$TACO_HOME/agents` or `$TACO_HOME/skills`. |
| Workspace | The execution directory's `.taco/agents` or `.taco/skills`. |
| Builtin | Original packaged definitions, including enabled extension skills. |

Select a configuration target without changing the open chat. Explicit source
views expose definitions hidden by another layer. The Agent editor can create,
edit, move, rename and delete Taco-owned global/workspace definitions; builtin
and compatible external definitions remain read-only. A workspace agent overrides
an identically named global agent. Skills from compatible directories can appear
in Effective without appearing in the Taco-owned source views.

Associated directories grant execution/read/write access according to policy;
they do not merge their agents, skills, MCP servers or other configuration into
the target. IM conversations have no editable workspace Agent layer. See the
[protocol's source-layer contract](sidecar-protocol.md)
for RPC scopes and memory inheritance.

### External subagent setup

| Runtime | Prerequisites | Runtime configuration |
|---|---|---|
| Claude Code | Local `claude` CLI and optional Agent SDK installed separately; usable Claude credentials. | User Claude settings; no managed installation card in Taco. |
| Codex | Install the pinned SDK runtime from Agents; npm is required for in-app installation. If unavailable, follow the displayed manual instructions. | User configuration under `$CODEX_HOME` (default `~/.codex`); an empty model override inherits it. |

Codex status separates installation from authentication. A third-party provider
with its own credentials does not require OpenAI login. Runtime sandbox,
approval policy and cwd belong to the agent definition; Taco checks the cwd
against the workspace and associated choices. Codex communication `tools`, when
set in the definition, are preserved by the editor; `[]` disables these bridge
tools and omission permits both `chatToAgent` and `listAgentSessions`.

Both runtimes retain native session identities for resume, separately from
Taco's display transcript. A native SDK session need not appear in the original
application's session list; visibility can depend on source and working directory.
For installation commands and retention details see the
[Sidecar runtime guide](../packages/sidecar/README.md#optional-dependencies).

## 6. Long-term memory

Project memories are Markdown topics under `$TACO_HOME/memory/projects/<workspace-key>/`;
user-level `MEMORY.md` supplies shared context. Project topic summaries enter the
model context, and the full topic text remains available to read when needed.

Use the Memory pane to review and edit topics, inspect recorded conversation
sources, and preview consolidation changes. Source metadata may be absent on
older topics; deleting a source conversation makes that conversation unavailable
without deleting the memory itself. Consolidation supports archive and restore;
purging an archive permanently removes those archived copies.

Automatic extraction is conservative: it may leave memory unchanged when a
conversation contains no supported, durable information. Memory updates are
separate from chat history, so an empty extraction does not mean a chat was lost.

### IM memory sources

Each full `im://<channelId>/<peerId>/<chatId>` identity owns a topic partition;
changing its execution directory does not merge topic memory with another chat.
IM inherits associated workspace topics read-only. The channel/chat policy's
`memory.inheritManagedGlobal` opt-in additionally reads topics from local
workspaces currently registered in that sidecar process, excluding associated
sources and other IM partitions. Human-maintained `MEMORY.md` stays shared.

The Memory pane marks inherited topics read-only. Model context summaries carry
`memoryLayer`, opaque `sourceId`, and `id`; the `memory` tool's `read` action
(or `memory.read` RPC) fetches the authorized full body. A source reference is
not a filesystem path or a grant: revoked associations and disabled inheritance
are checked on every read. Writes and consolidation target the current partition.
Old topics under the shared IM scratch identity are not copied automatically;
review them before selectively moving notes to conversation partitions.
