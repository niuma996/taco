# `@taco-ai/protocol`

Zero-dependency wire contract for the Taco sidecar protocol. RPC
parameter / result types, push frame DTOs, and the push-method
constants. Source of truth for every other package in the monorepo.

## Install

```bash
pnpm add @taco-ai/protocol
```

## What's here

- **`RpcRequest` / `RpcResponse` / `ServerPush`** — the three
  NDJSON frame shapes.
- **`SIDECAR_PROTOCOL_VERSION`** — the version tuple clients and
  servers negotiate on the `initialize` handshake.
- **Namespace DTOs** — `session.*`, `channel.*`, `mcp.*`,
  `memory.*`, `imPolicy.*`, `checkpoints.*`, `tools.*`,
  `agents.*`, `skills.*`, etc.
- **`PushMethods`** — `const` map of push method names, used by
  `SidecarServer` (to emit) and `TacoClient` (to route) by method
  name rather than by string literal.
- **`TacoGlobalConfigShape` / `TacoGlobalConfigView`** — the
  on-disk `taco.json` shape, plus its safe IPC view that strips
  secret-bearing fields.

## Stability

- `SIDECAR_PROTOCOL_VERSION` major bumps break compatibility.
- Existing RPC method names and parameter shapes are stable within
  a major version; new methods may be added in minor versions.
- Push frame `params` objects may gain fields in minor versions;
  field removal / rename is a major version bump.

See [`docs/sidecar-protocol.md`](../../docs/sidecar-protocol.md)
for the full wire contract.

## Layout

```
src/
├── index.ts          # barrel — all public re-exports
├── frames.ts         # RpcRequest / RpcResponse / ServerPush + version
├── session.ts        # session.* RPC types
├── channels.ts       # channels.* RPC + IM cwd helpers
├── checkpoints.ts    # checkpoints.* types
├── config.ts         # TacoGlobalConfigShape / View + constants
├── imPolicy.ts       # imPolicy.* types
├── memory.ts         # memory.* types
├── push.ts           # PushMethods + push payload types
└── tools.ts          # tools.* / agents.* / skills.* types
```

## Build

```bash
pnpm protocol:build    # tsc -p tsconfig.build.json → dist/
```

The build emits `.js` files (Node loads them under `NodeNext`);
downstream consumers (e.g. `@taco-ai/shared`) import from
`@taco-ai/protocol` and let Node resolve to `dist/`.

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
