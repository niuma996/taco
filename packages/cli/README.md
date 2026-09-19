# @taco-ai/cli

Taco command-line launcher and daemon supervisor. Wraps `@taco-ai/sidecar`
with user-facing subcommands and provides a single entry point the Tauri
desktop (and humans) can use to manage the sidecar daemon.

## Subcommands

| Command | Purpose | Output |
|---|---|---|
| `taco start` | Spawn the sidecar daemon in socket-bridge mode (or reuse an existing healthy one). Daemonizes after writing its data + control socket paths. | NDJSON socket path on stdout (last line); exits once the daemon is up. |
| `taco status` | Ping the control socket; report PID, uptime, protocol version, and instance id. | One-line summary on stdout; non-zero exit if no daemon is reachable. |
| `taco stop` | Send a graceful shutdown to the control socket; wait, then SIGTERM / SIGKILL. | Removes the data socket + PID + start lock on success. |
| `taco install` | Register the daemon as a system service so it survives reboots. macOS: LaunchAgent (`RunAtLoad` + `KeepAlive`). Windows: Task Scheduler `ONSTART` task. Linux: returns `unsupported platform`. | Writes the service definition; no stdout contract beyond the success line. |
| `taco uninstall` | Remove the registered service. macOS: unloads + deletes the plist. Windows: deletes the Task Scheduler entry. Linux: no-op with a warning. | Removes the system registration; user data (sessions, logs, config) is **not** touched. |
| `taco upgrade` | Download a new `@taco-ai/sidecar` release artifact, swap the binary, signal the daemon to restart. | Prints the installed version on stdout. |

All commands write diagnostics to stderr. A non-zero exit indicates a failure
of the operation itself (e.g. `taco stop` with no reachable daemon, `taco install`
on Linux); `--help` is always supported.

## Platform capabilities

| Capability | macOS | Windows | Linux |
|---|---|---|---|
| Spawn / connect to daemon | ✅ | ✅ | ✅ |
| `taco status` / `taco stop` | ✅ | ✅ | ✅ |
| `taco install` / `taco uninstall` (system service) | ✅ (LaunchAgent) | ✅ (Task Scheduler) | ❌ (unsupported) |
| Auto-restart on crash (via the registered service) | ✅ (`KeepAlive`) | ❌ (not configured) | ❌ |

Linux users who need daemon-on-boot must register the service themselves
(e.g. systemd user unit). `taco start` works on Linux; the daemon will run
as long as the user is logged in.

## Dev mode

Set `TACO_SIDECAR_DEV=1` (auto-detected when the CLI is launched from a
checkout containing `pnpm-workspace.yaml`) to spawn the bundle via
`tsx <repo>/packages/sidecar/src/index.ts` instead of the bundled
`@taco-ai/sidecar-<platform>` artifact. Hot reload + TypeScript source paths
in stack traces.

## Endpoints

| Platform | Data socket | Control socket |
|---|---|---|
| Unix | `$TACO_RUNTIME_DIR/sidecar.sock` | `$TACO_RUNTIME_DIR/sidecar-ctl.sock` |
| Windows | `\\.\pipe\taco-sidecar-<slug>` | `\\.\pipe\taco-sidecar-ctl-<slug>` |

`<slug>` is the first 16 hex chars of SHA-256 over a normalized
`$TACO_RUNTIME_DIR` (slash direction, trailing separator, and the
Windows `\\?\` prefix are stripped so equivalent paths hash the same).
Debug (`~/.taco-dev/run`) and release (`~/.taco/run`) therefore get
distinct pipes instead of colliding on a global `\\.\pipe\taco-sidecar`.
