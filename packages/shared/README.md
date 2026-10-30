# `@taco-ai/shared`

Typed Node-side RPC client for `@taco-ai/sidecar`. Wraps the raw
NDJSON-over-stdio framing in a class whose typed methods come from the
protocol contract table in `@taco-ai/protocol`.

## Install

```bash
pnpm add @taco-ai/shared
```

Depends on `@taco-ai/protocol` and requires Node ≥ 22.

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
- **`createDefaultSidecarSpawn()`** (in `./spawn.ts`) — defaults to
  `tsx packages/sidecar/src/index.ts` from the repository root. Installed
  consumers pass `{ command: "taco-sidecar", args: [] }` to use the bin on PATH.
  Options include `command`, `args`, `repoRoot` and `env`.

## Quick start

```typescript
import { asWorkspaceId } from "@taco-ai/protocol";
import { TacoClient } from "@taco-ai/shared/node";
import { createDefaultSidecarSpawn } from "@taco-ai/shared/spawn";

// Install @taco-ai/sidecar so its bin is available on PATH.
const client = new TacoClient(
    createDefaultSidecarSpawn({ command: "taco-sidecar", args: [] }),
);
await client.start();
try {
    await client.handshake();
    const workspace = asWorkspaceId("/tmp/myproject"); // use an existing project
    await client.workspaceEnsure(workspace);
    const { sessionId } = await client.sessionCreate({ workspace });
    await client.sessionAttach(workspace, sessionId);

    const unsub = client.onPush((push) => {
        if (push.method === "session.event") {
            // Push params are unknown here; narrow or validate before reading.
            console.log(push.workspace, push.session, push.params);
        }
    });
    try {
        await client.sessionPrompt({ workspace, sessionId, text: "hello" });
    } finally {
        unsub();
    }
} finally {
    await client.dispose();
}
```

## Browser note

The package root (`tacoClient.ts`) is **browser-safe** and imports no
`node:` modules. The `/node`, `/spawn` and `/controlNode` entry points are
Node-only; browser consumers should not import them.

## Layout

```
packages/shared/
├── tacoClient.ts       # browser-safe package root
├── tacoClientBase.ts   # transport-agnostic base class
├── tacoClientNode.ts   # Node-side child_process transport
├── dispatcher.ts       # FrameDispatcher / NdjsonLineBuffer
├── contractDispatch.ts # contract-bound send path + RpcDispatch interface
├── rpcError.ts         # validation-issue rendering for error messages
├── rpcMethods.ts       # wire-method names (re-exported from the protocol contract)
├── typedRpc.ts         # createTypedRpc + TypedRpc surface
├── spawn.ts            # createDefaultSidecarSpawn factory
└── controlNode.ts      # separate daemon control-socket client
```

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
