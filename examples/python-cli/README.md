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
2. Reads and validates the `sidecar.hello` push frame
3. Sends the mandatory `initialize` handshake (protocol v1.0+) and
   reads the server capabilities from the response
4. Calls `workspace.list`
5. Calls `session.create` (with `initialPrompt` to attach and run the
   first turn in one call)
6. Sends `session.prompt` and demonstrates push-frame interleaving

> **Why the `initialize` step matters.** Since protocol v1.0, the
> server rejects every RPC except `initialize` with code
> `not_initialized` until the handshake completes. The
> `clientCapabilities` field is optional but recommended.

## Protocol note

This script uses only the Python standard library (`subprocess`, `json`,
`uuid`). The entire protocol is plain NDJSON — no SDK, no generated
code required.
