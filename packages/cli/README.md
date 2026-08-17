# @taco-ai/cli

Taco command-line launcher and daemon supervisor. Wraps `@taco-ai/sidecar`
with user-facing subcommands (`start`, `status`, `install`, `upgrade`) and
provides a single entry point the Tauri UI (and humans) can spawn the sidecar
daemon through.

## Subcommands (this PR)

- `taco start` — spawn the sidecar daemon in socket-bridge mode. Prints the
  NDJSON socket path on stdout (last line) so callers can connect.

## Subcommands (later PRs)

- `taco status` (PR2 follow-up / PR3): ping the control socket, report uptime.
- `taco install` (PR3): write a launchd plist (macOS) / schtasks entry
  (Windows) so the daemon survives reboot.
- `taco upgrade` (PR4): download a new sidecar release artifact, swap binary,
  signal the daemon to restart.

## Dev mode

Set `TACO_SIDECAR_DEV=1` (auto-detected when the CLI is launched from a
checkout containing `pnpm-workspace.yaml`) to spawn the bundle via
`tsx <repo>/packages/sidecar/src/index.ts` instead of the bundled
`@taco-ai/sidecar-<platform>` artifact. Hot reload + TypeScript source paths
in stack traces.
