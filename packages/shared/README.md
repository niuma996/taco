# `@taco-ai/shared`

Typed Node-side RPC client for `@taco-ai/sidecar`. Wraps the raw
NDJSON-over-stdio framing in a class whose typed methods come from the
protocol contract table in `@taco-ai/protocol`.

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
- **`createTypedRpc(dispatch)`** — the typed method facade
  (`workspaceEnsure`, `sessionPrompt`, `agentsList`, …). Each method's
  payload and result type come from the protocol contract table, so the
  wire shape cannot drift from the sidecar's. Shared between the Node
  and Tauri transports.
- **`createContractDispatch(dispatch)`** — the contract-bound send path
  behind that facade: the method name determines the payload and result
  types, and the routing (workspace vs process) is checked at compile time.
- **`describeRpcError`** — folds a schema failure's field paths into the
  error message, so every surface that shows `error.message` explains
  which field was rejected.
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
├── contractDispatch.ts # contract-bound send path + RpcDispatch interface
├── rpcError.ts         # validation-issue rendering for error messages
├── rpcMethods.ts       # wire-method names (re-exported from the protocol contract)
├── typedRpc.ts         # createTypedRpc + TypedRpc surface
└── spawn.ts            # createDefaultSidecarSpawn factory
```

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
