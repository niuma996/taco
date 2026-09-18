# Taco

[English](README.md) · [中文](README.zh.md)

<p align="center">
  <img src="assets/taco.png" alt="Taco Logo" width="200" />
</p>

A minimal sidecar protocol layer + multi-client debug terminal built on Pi's `pi-agent-core` AgentHarness, exposing an NDJSON-over-stdio JSON-RPC surface so any client in any language can drive multi-workspace, multi-session agent conversations.

Taco ships four packages: the sidecar server (`@taco-ai/sidecar`), the typed Node client (`@taco-ai/shared`), the wire contract (`@taco-ai/protocol`), and the Tauri 2 + React desktop (`@taco-ai/desktop`).

## Project Highlights

- **`agent` tool.** Per-type tool whitelist, `agent/<type>` namespace, depth-bounded recursion, `executionMode: "parallel"` for concurrent calls.
- **`skill` tool.** Loads by name; inline enqueues `<skill_body name="NAME">` protected by `skillReinjector`, subagent mode spawns a fresh session via `spawnSkillSubagent`.
- **Plan mode.** `planEnter` opens `.taco/plans/<slug>.md`; only read / askUser / write-the-plan are allowed; `planExit` returns the plan for approval.
- **Prompt tag system.** Each `<tag>` carries a `compression` policy (`pin` / `pinOnce` / `summarize` / `drop`) and `tuiVisibility` (`visible` / `hidden` / `ephemeral`).
- **Extension system.** Workspace activation builds a frozen `WorkspaceExtensionSet` from process + workspace contributions. Built-ins: `projectManifests`, `gitContext`, `outputRedaction`. Register new tags via `registerExtensionTag`.
- **JSONL storage.** Sessions / history / event logs go through `JsonlSessionStorage` + `JsonlSessionRepo` — append-only, replayable, no schema migrations.
- **Pi as a dependency.** `pi-agent-core` and `pi-ai` pinned to `0.85.1`; consumes upstream APIs directly.
- **Standalone deploy.** `@taco-ai/sidecar` is a standalone npm package with its own bin. It supports two running modes — direct `NDJSON over stdio` (any language can drive it that way) and the long-lived daemon mode used by `taco start` and the Tauri desktop. Tenant isolation in daemon mode is "another control endpoint", not "another process".
- **One daemon, many workspaces.** The desktop daemon serves every workspace the UI has open, routed by `cwd`. The same NDJSON socket can carry traffic from multiple clients concurrently.

## What's Next

- **Plan / Tasks / Memory keep refining.** Reminder cadence, hook ordering, extraction prompt quality are still evolving.
- **Coding strength lands in extensions.** Patches / refactors / test runners go through the extension system.
- **Harden the safety envelope.** `PermissionBroker` already isolates read-only subagents and supports per-workspace IM policies; sandboxing and finer-grained IM policy are next.

## Repository Layout

```
taco/
├── packages/
│   ├── protocol/              # Wire contract (types + constants)
│   ├── shared/                # Typed Node client + spawn helper
│   └── sidecar/               # NDJSON over stdio service process
├── clients/
│   └── taco-desktop/          # Tauri 2 + React desktop client
├── examples/
│   ├── python-cli/            # Python integration sample
│   └── node-tui/              # Node TUI integration sample
├── docs/                      # Design docs + protocol spec
├── assets/                    # Images
└── scripts/                   # Repo-level scripts
```

## Quick Start

<p align="center">
  <img src="assets/desktop2.png" alt="Taco Desktop" />
</p>

```bash
git clone <repo> taco
cd taco
pnpm install
```

### Run the sidecar

```bash
cd packages/sidecar
pnpm dev   # tsx watch, NDJSON on stdio
```

On startup the sidecar is ready to serve the `initialize` RPC (protocol v2+).
Drive it from another terminal with any NDJSON-aware client.

### Run the desktop

```bash
cd clients/taco-desktop
pnpm install
pnpm tauri:dev
```

Tauri WebView opens with the sidebar (workspaces + sessions) and a chat pane. The shared `taco-sidecar` process is launched by the Rust backend on first `workspace_ensure` and shared across all open workspaces (see [docs/02-architecture.md](docs/02-architecture.md) §2.8).

> Debug builds run from repo source; release builds run the staged bundle, handled by `stageSidecar.mjs`.

### First-launch prompts on macOS / Windows

Because the published binaries are not code-signed with a paid developer certificate, the OS may show a one-time "untrusted" prompt the first time you open Taco. Always download from a release published by the repo owner — do not bypass prompts for installers from anywhere else.

**macOS — Gatekeeper "cannot be opened because the developer cannot be verified":**

1. Close the prompt. Open **System Settings → Privacy & Security**.
2. Scroll to the bottom; you'll see *"Taco was blocked from use because it is not from an identified developer."*
3. Click **Open Anyway** next to that message, then confirm in the dialog.
4. macOS records your choice and will not ask again for that binary.

If you cannot find the "Open Anyway" button (it only appears for ~1 hour after the first blocked launch), or you prefer to clear the quarantine attribute by hand for an app you already trust, run:

```bash
# Clear the quarantine attribute from a single downloaded app.
xattr -dr com.apple.quarantine "/Applications/Taco.app"
```

Use `xattr -d com.apple.quarantine <file>` to clear the flag from a single file inside the bundle. The `xattr` command only manipulates extended attributes on the file you point it at — it does not weaken system security globally.

**Windows — SmartScreen "Windows protected your PC":**

1. Click **More info** in the SmartScreen dialog.
2. The dialog expands to show the publisher name (or "Unknown") and a **Run anyway** button.
3. Click **Run anyway** to launch the installer.

Do not disable SmartScreen or Windows Defender to get past the prompt. SmartScreen's reputation check warms up after the binary is signed in a future release — the "More info → Run anyway" path is the supported workaround until then.

If the prompt says **"This app has been blocked for your protection"** or **"This app couldn't be installed because it might be harmful"**, the installer's SmartScreen reputation has dropped below the OS threshold. Cancel and download a fresh copy from the official release page; do not override the warning.

## Protocol

Taco enforces a single `initialize` handshake (mandatory since v1.0; the v1 `sidecar.hello` push frame was retired in v2):

```
client sends:   initialize      { protocolVersion, clientCapabilities }
server replies: initialize      { serverVersion, serverCapabilities, instanceId, pid }
```

`initialize` must succeed before any other RPC is accepted; every other call returns `not_initialized` until it does.

Full wire spec: [docs/sidecar-protocol.md](docs/sidecar-protocol.md). Regenerate with `pnpm sidecar:docs` after RPC changes.

## Third-Party Integration

`@taco-ai/sidecar` is published to npm as a standalone process; any language with a stdio interface can drive it.

```bash
npm i -g @taco-ai/sidecar
```

| Language | Example | Description |
|----------|---------|-------------|
| Python | [examples/python-cli/](examples/python-cli/) | Zero deps, `subprocess.Popen` + stdlib |
| Node.js | [examples/node-tui/](examples/node-tui/) | Uses `@taco-ai/shared` typed client |

```typescript
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";

const client = new TacoClient(
    createDefaultSidecarSpawn({ command: "taco-sidecar", args: [] }),
);

await client.start();
await client.handshake();   // protocol v2+: initialize RPC; returns InitializeResult
client.onPush((frame) => console.log("[push]", frame.method));

await client.workspaceList();
const { sessionId } = await client.sessionCreate({ workspace: cwd, initialPrompt: "hello" });
await client.sessionPrompt(cwd, sessionId, "echo ping");
```

## License

MIT — see [LICENSE](LICENSE).