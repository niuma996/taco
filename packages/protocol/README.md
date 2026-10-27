# `@taco-ai/protocol`

Shared wire contract for the Taco sidecar protocol. RPC
parameter / result types, push frame DTOs, and the push-method
constants. Source of truth for the main data RPC channel.

## Install

```bash
pnpm add @taco-ai/protocol
```

TypeScript consumers require **TypeScript 5.4 or newer**. The published
declarations use the built-in `NoInfer` type to infer RPC payloads from the
method alone, preventing a malformed payload from widening the inferred
method. JavaScript consumers do not need TypeScript.
Runtime schema construction depends on TypeBox.

## What's here

- **`RpcRequest` / `RpcResponse` / `ServerPush`** — the three
  NDJSON frame shapes.
- **`SIDECAR_PROTOCOL_VERSION`** — the version tuple clients and
  servers negotiate on the `initialize` handshake.
- **Namespace DTOs** — `session.*`, `channels.*`, `mcp.*`,
  `memory.*`, `imPolicy.*`, `checkpoints.*`, `tools.*`,
  `agents.*`, `skills.*`, etc. A request's wire shape is declared
  once, as a TypeBox schema in `schemas/`; the exported `*Params`
  type is derived from it, so the validator and the type cannot
  drift apart.
- **`PushMethods`** — `const` map of push method names, used by
  `SidecarServer` (to emit) and `TacoClient` (to route) by method
  name rather than by string literal.
- **`TacoGlobalConfigShape` / `TacoGlobalConfigView`** — the
  on-disk `taco.json` shape, plus its safe IPC view that strips
  secret-bearing fields.

## Adding an RPC method

1. Declare the request shape as a TypeBox schema in the matching
   `schemas/<domain>.ts` file.
2. Derive the exported params type from it:
   `export type FooParams = ParamsOf<typeof fooSchema>;`.
3. Add one row to the domain's `rpcContract/<domain>.ts` file:
   `foo: row<FooResult>()("foo.bar", "workspace", fooSchema)`.

The contract table reads the params type off the schema, so the
row carries no second copy of the shape. For branded ids, use the
shared `workspaceIdSchema` / `sessionIdSchema` / `toolCallIdSchema`
from `schemas/fields.ts` instead of a bare `Type.String()`; otherwise
the brand is silently lost. A schema that must stay looser than its
type — an open body, or a deliberately permissive gate — pins the
type with `Type.Unsafe<T>(...)`.

## Boundaries

The main data channel runs over stdio or the daemon data socket. Tauri
commands/events and the daemon control socket have separate contracts.
Desktop-only preferences and aggregate view fields stay in the desktop;
`settings.get` returns the sidecar's `{ global }` view only.

Request schemas validate shapes without casting or stripping input.
Handlers retain authorization, state and cross-field checks. `initialize`
is deliberately permissive, and config patch bodies stay open. Result
and push payload DTOs currently have no runtime schema validation.

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
├── config.ts         # TacoGlobalConfigShape / View — the on-disk config only
├── configPatch.ts    # the open-body global-config request types
├── memory.ts         # memory.* / checkpoints.* types
├── rpcContract/      # domain contracts + their request/result types, scope assertions
├── schemas/          # RPC parameter validators — the source of every request shape
│   └── fields.ts     # shared branded-id and payload field schemas
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

For local development, rebuild after changing protocol source or switching
branches, before starting sidecar or running its tests. Consumers load the
built package, so stale `dist/` can cause missing named-export errors (for
example, `does not provide an export named 'jobIdSchema'`). Run
`pnpm protocol:build` from the repository root to refresh it.

Exported schemas include `description` metadata shared with model-facing
tools. Description edits affect the published schema objects but do not
change validation behavior.

## License

MIT — see [LICENSE](LICENSE) (symlink to the root).
