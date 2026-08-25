# `@taco-ai/debug-console`

A minimal CLI REPL for manually exercising the sidecar protocol.
Useful for debugging — every RPC and push frame is logged to
stderr, separate from stdin echo.

## Install

```bash
pnpm add -g @taco-ai/debug-console
```

Requires `@taco-ai/sidecar` on `PATH` (or set
`TACO_SIDECAR_CMD` / `TACO_SIDECAR_ARGS` to override).

## Quick start

```bash
# Spawn sidecar + REPL
debug-console start

# One-shot prompt against a workspace
debug-console send /tmp/myproject "hello world"

# Pull history for a session
debug-console history /tmp/myproject <sessionId>

# Subscribe to pushes only (no REPL)
debug-console watch /tmp/myproject
```

## REPL commands

Inside `debug-console start`:

- `/list` — list active workspaces
- `/send <text>` — `session.create` + `session.prompt` against the
  current workspace
- `/cd <cwd>` — change the current workspace
- `/checkpoints` — list turn-scoped checkpoints for the active
  session
- `/restore <id>` — restore a checkpoint (asks `yes/no` before
  executing)
- `/quit` / `/exit` — terminate

The first line printed is `[taco] sidecar ready`, confirming the
`initialize` RPC handshake completed (the response carries the
sidecar's protocol version and identity). Anything before that line
means the sidecar failed to start — see the same terminal's stderr
for the actual error.

## When to use it

- **Debugging a new RPC.** Send a request by hand, watch the
  push stream in real time, and see exactly what the sidecar
  emits.
- **Reproducing a user report.** Drive the sidecar with the same
  workspace / session / model and watch the push stream.
- **Smoke-testing a release.** `debug-console start` against a
  freshly-staged `dist/` is the fastest way to confirm a build
  is wired correctly.

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
