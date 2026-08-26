# `@taco-ai/shared`

Typed Node-side RPC client for `@taco-ai/sidecar`. Wraps the raw
NDJSON-over-stdio framing in a class with 53 typed methods
(auto-generated from `rpcMethods.ts`).

## Install

```bash
pnpm add @taco-ai/shared
```

Requires `@taco-ai/protocol` (peer) and Node ≥ 22.

## What's here

- **`TacoClient`** (in `./tacoClientNode.ts`) — spawns a
  sidecar child process, pipes stdio, parses NDJSON frames,
  registers pending requests, dispatches pushes. Subclass
  `TacoClientBase`; the typed methods are injected via
  `createTypedRpc`.
- **`TacoClientBase`** — transport-agnostic dispatcher /
  pending-promise registry / typed RPC injection. Subclassed by
  the Tauri-flavored client inside `@taco-ai/desktop`.
- **`createTypedRpc(dispatch)`** — generates 53 typed wrappers
  (`workspaceEnsure`, `sessionPrompt`, `agentsList`, …) from a
  two-method dispatch interface. Shared between the Node and
  Tauri transports.
- **`FrameDispatcher` / `NdjsonLineBuffer`** — the frame parser,
  deduplicator, and pending-promise map. Exposed for tooling that
  wants to drive the sidecar over a custom transport.
- **`createDefaultSidecarSpawn()`** (in `./spawn.ts`) — picks
  `taco-sidecar` on PATH with no extra args. Override via
  `{ command, args, cwd, env }` for testing.

## Quick start

```typescript
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";

const client = new TacoClient(createDefaultSidecarSpawn());
await client.start();
await client.handshake();   // protocol v2+: initialize RPC; returns InitializeResult

const list = await client.sessionList("/tmp/myproject");
const sid = await client.sessionCreate({
    workspace: "/tmp/myproject",
    initialPrompt: "hello",
});
const reply = await client.sessionPrompt("/tmp/myproject", sid, {
    text: "continue",
});

// Subscribe to pushes.
const unsub = client.onPush((p) => {
    if (p.method === "session.event") {
        // p.workspace, p.session, p.params.event are typed
    }
});

await client.dispose();
```

## Browser note

The barrel `./index.ts` is **browser-safe** (no `node:` imports).
The `tacoClientNode.ts` and `spawn.ts` entry points are Node-only.
Vite / webpack will tree-shake Node-only imports if you only import
the barrel.

## Layout

```
src/
├── index.ts            # browser-safe barrel
├── tacoClientBase.ts   # transport-agnostic base class
├── tacoClientNode.ts   # Node-side child_process transport
├── dispatcher.ts       # FrameDispatcher / NdjsonLineBuffer
├── rpcMethods.ts       # wire-method name constants (single source of truth)
├── typedRpc.ts         # createTypedRpc + TypedRpc surface
└── spawn.ts            # createDefaultSidecarSpawn factory
```

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
