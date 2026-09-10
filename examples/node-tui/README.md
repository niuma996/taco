# Node TUI Example

Minimal terminal UI that calls `taco-sidecar` over NDJSON stdio via
the published `@taco-ai/{protocol,shared}` typed client.

## Prerequisites

- Node.js 22+
- `taco-sidecar` reachable as one of:
  - on `PATH` (e.g. `npm i -g @taco-ai/sidecar@^0.2.0`),
  - **or** set `TACO_SIDECAR_CMD` (and optionally `TACO_SIDECAR_ARGS`)
    to point at the sidecar process (e.g. `tsx packages/sidecar/src/index.ts`
    for a monorepo dev run).

## Install

```bash
cd examples/node-tui
pnpm install
```

`pnpm install` resolves `@taco-ai/protocol@^0.2.0` and
`@taco-ai/shared@^0.2.0` from npm.

### Running against a monorepo checkout

When testing changes to the protocol or the typed client before a
release is published, link the workspace copies so `pnpm install`
picks up your local builds:

```bash
# from the repo root — build the libraries the example imports
pnpm protocol:build && pnpm shared:build

# in this directory — link the workspace copies (no tsx needed at this point)
pnpm link ../../packages/protocol
pnpm link ../../packages/shared
```

`pnpm link` symlinks the workspace packages so `@taco-ai/shared`'s
transitive `@taco-ai/protocol` resolves to the local build.

## Run

```bash
pnpm dev
```

The TUI listens for push frames and prints them as they arrive. Exit
with `Ctrl-C`.

## Typed client at a glance

```ts
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";

const client = new TacoClient(
    createDefaultSidecarSpawn({
        command: process.env.TACO_SIDECAR_CMD ?? "taco-sidecar",
        args: process.env.TACO_SIDECAR_ARGS?.split(" ") ?? [],
    }),
);

await client.start();
await client.handshake({
    protocolVersion: { major: 2, minor: 0 },
    clientCapabilities: {},
});
client.onPush((frame) => console.log("[push]", frame.method));

const { sessionId } = await client.sessionCreate({
    workspace: process.cwd(),
    initialPrompt: "hello",
});
await client.sessionPrompt(process.cwd(), sessionId, "echo ping");

await client.dispose();
```

The typed client returns a Promise per RPC and resolves it when the
`id`-matched response arrives; push frames are surfaced through
`onPush` and never block the pull response.

## Minimal stdio round-trip

For a non-interactive smoke test of the protocol surface, the shared
script in `examples/snippets/typed_smoke.ts` covers
`initialize → workspace.list → workspace.ensure → session.list`
without creating a session.
