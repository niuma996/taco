# Python CLI Example

Zero-dependency Python client for `taco-sidecar` over NDJSON stdio.
The script demonstrates the wire protocol without any npm / Node
dependency on the client side — only the sidecar itself.

## Prerequisites

- Python 3.9+
- `taco-sidecar` reachable as one of:
  - on `PATH` (e.g. `npm i -g @taco-ai/sidecar@^0.2.0`),
  - the bundled binary from a release tarball at
    `<install-prefix>/lib/node_modules/@taco-ai/sidecar/dist/runtime/<platform>/bin/taco-sidecar-node`,
  - a monorepo checkout running `pnpm dev` in `packages/sidecar`
    (TypeScript source via `tsx`),
  - **or** set `TACO_SIDECAR_CMD` (and optionally `TACO_SIDECAR_ARGS`) to
    point at any of the above. For a monorepo checkout:

    ```bash
    export TACO_SIDECAR_CMD=tsx
    export TACO_SIDECAR_ARGS='packages/sidecar/src/index.ts'
    ```

## Install

Nothing to install — the script uses only the Python standard library.
Clone (or copy) `taco_client.py` and run it directly.

## Usage

```bash
python3 taco_client.py [cwd]
```

`cwd` defaults to the current directory.

## What it does

1. Spawns `taco-sidecar`.
2. Sends the mandatory `initialize` handshake (protocol v2+) and
   reads `serverVersion` / `protocolVersion` / `pid` / `instanceId`
   from the response.
3. Calls `workspace.list`.
4. Calls `session.create` with `initialPrompt` so the session is
   attached and the first turn runs in the same RPC.
5. Sends `session.prompt` and demonstrates push-frame interleaving:
   any `session.event` push frames that arrive while the RPC is in
   flight are printed and the function keeps reading until the
   `id`-matched response lands.

> **Why `initialize` matters.** Since protocol v1.0, every RPC except
> `initialize` returns `not_initialized` until the handshake completes.
> In v2 the v1 `sidecar.hello` push frame was retired; the identity
> fields moved onto the `initialize` response, which is now the
> readiness signal.

## Minimal stdio round-trip

For environments where installing the full client is overkill, the
shared smoke script in `examples/snippets/stdio_smoke.py` covers
`initialize → workspace.list → workspace.ensure → session.list`
without touching LLM state.
