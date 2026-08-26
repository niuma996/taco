# Python CLI Example

Zero-dependency Python client demonstrating the `taco-sidecar` NDJSON-over-stdio protocol.

## Prerequisites

- `taco-sidecar` installed and on `PATH` (e.g. `npm i -g @taco-ai/sidecar`),
  **or** a checkout of this repo with `pnpm dev` running in `packages/sidecar`.
- Python 3.9+

## Install

No install step — the script is self-contained and uses only the Python
standard library. Just clone the repo (or copy `taco_client.py`) and run it
directly. The only "external" requirement is `taco-sidecar` itself, which
the [Prerequisites](#prerequisites) section above covers.

## Usage

```bash
python3 taco_client.py [cwd]
```

`cwd` defaults to the current directory.

## What it does

1. Spawns `taco-sidecar`
2. Sends the mandatory `initialize` handshake (protocol v2+) and
   reads the server capabilities + identity (serverVersion / pid /
   instanceId) from the response
3. Calls `workspace.list`
4. Calls `session.create` (with `initialPrompt` to attach and run the
   first turn in one call)
5. Sends `session.prompt` and demonstrates push-frame interleaving

> **Why the `initialize` step matters.** Since protocol v1.0, the
> server rejects every RPC except `initialize` with code
> `not_initialized` until the handshake completes. The
> `clientCapabilities` field is optional but recommended.
>
> **v1 → v2.** v2 removed the `sidecar.hello` push frame; the identity
> fields that lived on it (`version` / `pid` / `instanceId`) are now
> carried on the `initialize` response. The handshake is the same
> single RPC, the readiness signal is the same response — only the
> wire shape changed.

## Protocol note

This script uses only the Python standard library (`subprocess`, `json`,
`uuid`). The entire protocol is plain NDJSON — no SDK, no generated
code required.
