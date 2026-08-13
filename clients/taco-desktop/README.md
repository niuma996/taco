# `@taco-ai/desktop`

Tauri 2 + React desktop for Taco. The reference client for
`@taco-ai/sidecar` — owns the sidecar process, drives the typed
RPC client, and renders the chat / sessions / settings / MCP /
agents / skills / plugins / channels / memory / checkpoints panes.

## Install (developer)

```bash
# In a clean checkout
pnpm install
pnpm tauri:dev    # debug build; sidecar runs from repo source
```

`scripts/stageSidecar.mjs` runs automatically before both `tauri:dev`
and `tauri:build` (wired into `beforeDevCommand` / `beforeBuildCommand`
in `tauri.conf.json`), so the `externalBin` resource Tauri's build.rs
checks for always exists — including on a fresh checkout, before you've
ever built the sidecar runtime.

A debug build still runs sidecar via `tsx packages/sidecar/src/index.ts`
out of the repo, so edits to sidecar code take effect without a
re-stage. A release build runs the staged bundle + bundled node binary
that `stageSidecar.mjs` copies into the Tauri layout.

## Install (end-user)

A release build produces platform-specific bundles (`.dmg` /
`.app` for macOS, `.exe` / `.msi` for Windows, `.AppImage` /
`.deb` for Linux). See the GitHub Releases page.

## What's here

- **`src/`** — React 19 frontend (Vite + TypeScript).
  - **`App.tsx`** — top-level layout, sidecar-stream wiring,
    state machine for workspaces / sessions.
  - **`views/`** — `ChatPane` / `Sidebar` / `SettingsPane` /
    `ToolsPane` / `SkillsPane` / `AgentsPane` / `PluginsPane` /
    `ChannelsPane` / `MemoryPane` / `CheckpointsPane`.
  - **`components/`** — primitive UI (`ui/`), feature widgets
    (`panels/`, `toolViews/`, `settings/`, `onboarding/`).
  - **`hooks/`** — `useWorkspaces` (state machine) /
    `useSidecarStream` (push routing + dedup) /
    `use*Pane` (per-view data fetchers).
  - **`lib/`** — `TacoClient` (Tauri transport) /
    `applyEventToMessages` (push → UI model) /
    `workspaceReducer` (pure state transitions) /
    `sidecarLogLine.ts` (stderr parser).
  - **`i18n/`** — react-i18next with `locales/{en,zh}.json`.
- **`src-tauri/`** — Rust backend.
  - **`src/lib.rs`** — spawn sidecar, byte-pipe stdout to Tauri
    events `sidecar-event` / `sidecar-exited`, `desktop.json`
    read/write, `paths_are_dirs` existence probe,
    `default_workspace_dir`, `set_fs_scope` for the FS plugin.
  - **`src/log_file.rs`** — size-capped rotating log writer for
    `taco-desktop.log` + `llm-dump.log`.
- **`scripts/stageSidecar.mjs`** — copies sidecar runtime artifacts
  into the Tauri layout; runs automatically before both `tauri:dev`
  and `tauri:build` via `tauri.conf.json`'s `beforeDevCommand` /
  `beforeBuildCommand`.

## Tauri commands exposed

| Command | Purpose |
|---------|---------|
| `workspace_ensure(cwd, debugMode, llmDumpToFile)` | Spawn the shared sidecar (or reuse the existing one); returns the captured first stdout line. |
| `workspace_send(cwd, line)` | Write a single NDJSON line to the sidecar's stdin. `cwd` is API-compat only. |
| `workspace_dispose_all()` | SIGTERM the sidecar; SIGKILL after 3 s. |
| `set_fs_scope(path)` | Grant the FS plugin recursive access to `path`. |
| `desktop_config_read` / `desktop_config_write` | Read / write `~/.taco/desktop.json`. |
| `default_workspace_dir()` | Return `$TACO_HOME/workspace`, mkdir if missing. |
| `paths_are_dirs(paths)` | Bulk existence probe for workspace pruning. |

The Rust layer is a byte pipe — it does not parse NDJSON. The
React side does all frame parsing, routing, and dedup.

## Tauri events emitted

- **`sidecar-event { line }`** — every stdout line from the
  sidecar, forwarded verbatim. The frontend dispatcher decides
  push vs response vs error.
- **`sidecar-exited { code?, reason? }`** — process-level death
  signal. The frontend rejects every pending RPC and re-prompts
  the user to restart.

## Overriding the sidecar spawn (e2e / dev)

The desktop honors `TACO_SIDECAR_CMD` / `TACO_SIDECAR_ARGS` /
`TACO_SIDECAR_CWD` env vars at spawn time. Use them to point at a
local build:

```bash
TACO_SIDECAR_CMD=tsx TACO_SIDECAR_ARGS='packages/sidecar/src/index.ts' \
  pnpm tauri:dev
```

Debug builds automatically use repo-source; release builds ignore
the override and use the staged bundle.

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
