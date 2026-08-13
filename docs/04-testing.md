# Testing & Debugging Guide

> How to run end-to-end verification and capture runtime evidence.

## 1. End-to-end testing

### Tier 1 — protocol smoke (no API key needed)

Start sidecar, send hello + initialize + workspace.ensure:

```bash
cd packages/sidecar
pnpm dev    # starts sidecar with stdio transport
```

In a second terminal, drive the protocol manually (see
`scripts/pack-smoke.mjs` for the canonical example). Expect:

- `sidecar.hello` frame (liveness)
- `initialize` response with `serverCapabilities`
- `workspace.ensure` returns `{ ok: true, result: { cwd, sessionsRoot } }`

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

Type a line at the `taco>` prompt. Expect: hello frame on connect,
`[event] ...` lines for each `session.event` push (the terminal
truncates the payload to 120 chars — it does not render token-level
streaming deltas), then `[response] ...` once the turn completes.

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
{ echo '{"id":"1","method":"initialize","params":{"protocolVersion":{"major":1,"minor":3}}}' ; sleep 5 ; } \
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