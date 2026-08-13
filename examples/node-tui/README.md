# Node TUI Example

Minimal terminal UI that calls `taco-sidecar` using `@taco-ai/shared`.

## Prerequisites

- `taco-sidecar` installed and on `PATH` (e.g. `npm i -g @taco-ai/sidecar`)
- Node.js 22+

## Setup

This example depends on the published `@taco-ai/protocol` and `@taco-ai/shared`
packages:

```bash
cd examples/node-tui
pnpm install
```

### Running before the packages are published

The two libraries aren't on npm yet, so `pnpm install` can't fetch them. To run
against the monorepo checkout, build them and link them in:

```bash
# from the repo root — build the libraries the example imports
pnpm protocol:build && pnpm shared:build

# in this directory — link the workspace copies, then add tsx
cd examples/node-tui
pnpm link ../../packages/protocol
pnpm link ../../packages/shared
pnpm add -D tsx
```

`pnpm link` symlinks the workspace packages (with their own resolved
`node_modules`), so `@taco-ai/shared`'s `@taco-ai/protocol` dependency resolves
even though this example is not a workspace member.

## Run

```bash
pnpm start [cwd]     # cwd defaults to process.cwd()
```

## What it demonstrates

1. `createDefaultSidecarSpawn({ command: "taco-sidecar", args: [] })` — the recommended
   spawn configuration for external callers
2. `TacoClient` — typed RPC calls (`sessionCreate`, `sessionPrompt`) whose results
   are awaited directly
3. `onPush` — server-initiated frames (`session.event`, `session.error`) stream in
   via the push callback while an awaited RPC is in flight; RPC responses resolve
   their promise and never reach `onPush`
