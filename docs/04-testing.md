# Testing & Debugging Guide

> How to run end-to-end verification and capture runtime evidence.

## Release regression checks

From the repository root, run `pnpm protocol:build`, `pnpm shared:build`,
`pnpm lint`, `pnpm lint:comments`, `pnpm typecheck`, `pnpm deps:circular`,
`pnpm test`, the desktop build, and `pnpm pack:smoke`. These checks require no
paid model call; SDK tests use isolated fake providers and transports.

When the default parallel package run saturates filesystem event delivery, use
the same complete package suite with bounded concurrency, then run the client
and component suites normally:

```bash
node --experimental-transform-types \
  --import ./packages/sidecar/tests/_helpers/tsResolveHooks.ts \
  --import ./packages/sidecar/tests/_helpers/testSetup.ts \
  --test-concurrency=4 --test-force-exit --test 'packages/**/tests/**/*.test.ts'
pnpm test:client
pnpm test:components
```

Check multi-workspace navigation and restored groups, scoped Agent CRUD and
Codex tool restrictions, authorized memory reads after association revocation,
IM handoff replay, recovered cancellation, self-fired jobs, and child message
settlement. Regressions live beside their module tests; no manual API login is
needed. A real runtime smoke test is separate: native credentials and an
installed Claude/Codex SDK are required, and model turns may incur charges.

## 1. End-to-end testing

### Tier 1 — protocol smoke (no API key needed)

Start sidecar, send initialize + workspace.ensure:

```bash
cd packages/sidecar
pnpm dev    # starts sidecar with stdio transport
```

In a second terminal, drive the protocol manually. The runnable
versions of this are `examples/snippets/stdio_smoke.py` (hand-rolled
NDJSON) and `examples/snippets/typed_smoke.ts` (typed client) — both
drive the same frame sequence. Expect:

- `initialize` response with `serverCapabilities` (and identity:
  `serverVersion` / `pid` / `instanceId`)
- `workspace.ensure` returns `{ ok: true, result: { cwd } }`

> Protocol v2 retired the `sidecar.hello` push frame; readiness and
> identity now travel on the `initialize` response.

### Tier 2 — Node client smoke (no API key)

The `examples/node-tui` driver attaches a session with an `initialPrompt`,
then expects the LLM to respond. That requires an API key for any
non-trivial run, so this tier is the same as Tier 3 (just verify it
boots without crash; if the model surfaces an auth error, that is the
expected behavior — the protocol stack is the success criterion here).

### Tier 3 — Node client E2E (API key needed)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cd examples/node-tui
pnpm start /tmp/test
```

Type a line at the `taco>` prompt. Expect: `initialize` handshake on
connect (the v1 hello frame is gone), `[event] ...` lines for each
`session.event` push (the terminal truncates the payload to 120 chars —
it does not render token-level streaming deltas), then `[response] ...`
once the turn completes.

### Tier 4 — desktop

```bash
cd clients/taco-desktop
pnpm install
pnpm tauri:dev
```

Tauri WebView opens with the sidebar (workspaces + sessions) and the
chat pane. The shared `taco-sidecar` process is launched by the Rust
backend on first `workspace_ensure`.

## 2. Debugging tips

### Raw NDJSON capture

```bash
cd packages/sidecar
{ echo '{"id":"1","method":"initialize","params":{"protocolVersion":{"major":2,"minor":0},"clientCapabilities":{}}}' ; sleep 5 ; } \
  | pnpm exec tsx src/index.ts 2>&1 | tee /tmp/taco-log.txt
```

### Inspect a session's JSONL

```bash
ls -la ~/.taco/sessions/<workspace>/*.jsonl
head -3 ~/.taco/sessions/<workspace>/*.jsonl
```

### Reset sessions

```bash
rm -rf ~/.taco/sessions
```

The sidecar will not auto-cleanup; this is a manual reset.

### Reset config

```bash
rm ~/.taco/taco.json
```

The next sidecar start will rebuild with defaults (`enabled: true`,
`threshold: 0.7`).