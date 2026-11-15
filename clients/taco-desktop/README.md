# `@taco-ai/desktop`

Tauri 2 + React desktop for Taco. The reference client for
`@taco-ai/sidecar` — talks to the sidecar **daemon** over a long-lived
NDJSON socket (with a separate control socket for `start` / `status` /
`stop`), drives the typed RPC client, and renders the chat / sessions /
settings / MCP / agents / skills / plugins / channels / memory /
checkpoints panes. Direct stdio mode is supported by the sidecar but is
not used by the desktop.

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

> The first time you launch a release binary, macOS Gatekeeper and
> Windows SmartScreen may each show a one-time "untrusted" prompt.
> The root README has step-by-step workarounds (Privacy & Security
> → Open Anyway, and SmartScreen → More info → Run anyway). Do
> **not** disable SmartScreen or Gatekeeper to bypass them.

### Lifecycle: close ≠ quit

The desktop is a tray-resident app:

- **Close button hides to tray**, not quits. The window's CloseRequested is
  intercepted; clicking the X on the title bar hides the window and leaves
  the sidecar daemon running in the background. The single-instance
  plugin means a second launch focuses the existing window instead of
  opening a new one.
- **System tray** (or menu bar on macOS) has **Show Taco** and **Quit Taco**.
  Quit Taco runs the application-level exit handler, which terminates the
  sidecar daemon and only then exits the Tauri app. Use Quit when you want
  the daemon to actually stop.
- **macOS Dock**: clicking the dock icon reopens a hidden window.
- **Daemon reconnect**: if the daemon exits unexpectedly (crash, manual
  kill), the frontend rejects every in-flight RPC, then transparently
  retries the reconnect with backoff `500ms → 1s → 2s → 5s` (up to four
  attempts). On success, `initialize` runs again and the active session is
  re-attached. **Active requests are not replayed** — they fail loudly so
  the user can decide whether to resubmit. Active Quit / Restart paths do
  not trigger this loop.
- **All four reconnect attempts fail**: stop and let the user intervene
  (reopen manually, run `taco status` from the CLI to confirm the daemon
  state, or check `~/.taco/logs/daemon.err.log`). The UI surfaces a banner
  but does not silently retry forever.

### Auto-registered system service

On the first launch of a non-debug release build, the desktop setup flow
runs `taco install` to register a system-level daemon:

- **macOS** — LaunchAgent in `~/Library/LaunchAgents/`, with `RunAtLoad`
  and `KeepAlive` (the daemon restarts after a crash).
- **Windows** — Task Scheduler task running at user sign-in (per-user,
  unelevated, so the installer can stop the daemon when upgrading).
  **Crash restart is not configured** in this release.
- **Linux** — `taco install` returns `unsupported platform`. There is no
  auto-registration; use a systemd user unit if you need daemon-on-boot.

`taco uninstall` removes the system registration but leaves user data
(sessions, logs, `~/.taco/`) intact.

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
  - **`src/lib.rs`** — connect to the sidecar daemon over its NDJSON
    socket (split reader + writer), forward each NDJSON frame as a
    Tauri event `sidecar-event`, bridge to the control socket for
    `start` / `status` / `stop`, manage `desktop.json` read/write,
    `paths_are_dirs` existence probe, `default_workspace_dir`,
    `set_fs_scope` for the FS plugin.
  - **`src/log_file.rs`** — size-capped rotating log writer for
    `taco-desktop.log` + `llm-dump.log`.
- **`scripts/stageSidecar.mjs`** — copies sidecar runtime artifacts
  into the Tauri layout; runs automatically before both `tauri:dev`
  and `tauri:build` via `tauri.conf.json`'s `beforeDevCommand` /
  `beforeBuildCommand`.

## Management query cache

`main.tsx` provides one TanStack Query client. Providers, models, tools, skills,
plugins, agent catalog/content/runtime, jobs, checkpoints and Work detail reads share
this cache. Keys isolate
TacoClient instances, workspace targets, configuration scopes and detail identities.
UI selection and mutation navigation guards stay in their feature hooks.

Providers and models remain fresh for 30 seconds, with at most five retries
(1/2/4/8/8 seconds). Other migrated panes refresh on entry and report read failures
without retries. Browser focus and network reconnect events do not trigger RPCs:
the local sidecar is independent from browser online status.

Connection readiness cancels pending query results before invalidating this
client's cache. `models.changed` invalidates the affected workspace; provider
configuration saves invalidate provider/model entries across all workspaces.
Inactive entries fetch when enabled again. Cancelling a query protects cache
publication; it does not abort an RPC already sent to the sidecar. The cache
holds no secret reveal or provider connection-test results and is not persisted.

Checkpoint lists are keyed by client and workspace and reuse the root reconnect
invalidation. Every restore outcome invalidates its originating workspace,
including failures that may have partially changed files or created a protection
checkpoint. Restore calls run once; list refresh failures do not change the
restore outcome. Inactive lists refetch when enabled again.

Job queries share process-level list/detail/history keys between Schedules and
Memory consolidation settings. Confirmed updates publish the returned Job before
refetching so a later read failure retains the acknowledged configuration.
Open history dialogs poll every 10 seconds, including while the app is unfocused,
and refresh on Work changes. Closing a dialog disables its reads and polling.
Work details share a `(client, workId, revision)` key between the Work pane and
history dialogs; completed reads remain reusable until invalidation, and inactive
detail entries are collected after 60 seconds. Reconnection invalidates these
queries through the existing application subscription.

## Tauri commands exposed

| Command | Purpose |
|---------|---------|
| `workspace_ensure(cwd)` | Connect to the shared sidecar daemon (or prewarm one); idempotent. |
| `workspace_send(cwd, line)` | Send a single NDJSON line over the daemon socket. `cwd` is API-compat only. |
| `workspace_dispose_all()` | Tear down the desktop-side connection; the daemon keeps running until the tray Quit path or `taco stop` requests shutdown. |
| `set_fs_scope(path)` | Grant the FS plugin recursive access to `path`. |
| `desktop_config_read` / `desktop_config_write` | Read / write `~/.taco/desktop.json`. |
| `default_workspace_dir()` | Return `$TACO_HOME/workspace`, mkdir if missing. |
| `paths_are_dirs(paths)` | Bulk existence probe for workspace pruning. |

The Rust layer forwards NDJSON frames verbatim; it does not parse them.
The React side does all frame parsing, routing, dedup, and reconnect.

## Tauri events emitted

- **`sidecar-event { line }`** — every NDJSON frame received from the
  daemon's data socket, forwarded verbatim. The frontend dispatcher
  decides push vs response vs error.
- **`sidecar-exited { code?, reason? }`** — connection-level death. The
  frontend rejects every in-flight RPC and starts the bounded reconnect
  loop described in **Lifecycle: close ≠ quit** above.

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
