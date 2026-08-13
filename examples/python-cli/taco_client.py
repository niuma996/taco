#!/usr/bin/env python3
"""
taco_client.py — Zero-dependency taco-sidecar client in Python.

Demonstrates the NDJSON-over-stdio protocol with a real `taco-sidecar`
process.  No npm/node required to read this file; the protocol is plain JSON.

Usage:
    python3 taco_client.py [cwd]

If `taco-sidecar` is not on PATH, set the TACO_SIDECAR_CMD environment variable.

Wire flow (protocol v1.3+):
    spawn sidecar
    → read sidecar.hello push (liveness, optional)
    → send initialize { protocolVersion: { major, minor } }           [MANDATORY]
    → await initialize response
    → call workspace.list, session.create, session.prompt, ...
"""

import json
import os
import subprocess
import sys
import uuid


def send(writer, method: str, params: dict | None = None) -> str:
    """Write an NDJSON request frame; return the request id."""
    req_id = str(uuid.uuid4())
    frame = {"id": req_id, "method": method, "params": params or {}}
    writer.write(json.dumps(frame) + "\n")
    writer.flush()
    return req_id


def read_frame(fd) -> dict:
    """Read one NDJSON line, skipping empty/whitespace-only lines."""
    for line in fd:
        line = line.strip()
        if line:
            return json.loads(line)
    raise EOFError("sidecar closed stdout")


def read_response(fd, req_id: str) -> dict:
    """Read frames until the RPC response matching `req_id` arrives.

    A response frame carries `ok: bool` and the matching `id`. Anything else is
    a server push (session.event, tasks.updated, ...) that may interleave with the
    response of a long-running RPC — print it and keep reading.
    """
    while True:
        frame = read_frame(fd)
        if isinstance(frame.get("ok"), bool) and frame.get("id") == req_id:
            return frame
        # push notification (no id-matched pending request)
        print(f"[python-cli] push ← {frame.get('method')}")


def main() -> None:
    cwd = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    cmd = os.environ.get("TACO_SIDECAR_CMD", "taco-sidecar").split()

    print(f"[python-cli] Starting taco-sidecar (cwd={cwd})…")
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        text=True,
    )

    # ── 1. Read hello (liveness only) ────────────────────────────────────
    hello = read_frame(proc.stdout)
    assert hello.get("method") == "sidecar.hello", f"unexpected hello: {hello}"
    print(
        f"[python-cli] sidecar hello: version={hello['params']['version']}, "
        f"pid={hello['params']['pid']}"
    )

    # ── 2. Initialize (mandatory since protocol v1.3) ──────────────────
    # Without this step every subsequent RPC would be rejected with
    # `not_initialized`. The hello frame's `params.protocol` is the sidecar's
    # supported version; we echo the same major/minor back so the server
    # accepts us.
    server_protocol = hello["params"].get("protocol", {"major": 1, "minor": 3})
    init_req = send(
        proc.stdin,
        "initialize",
        {
            "protocolVersion": {
                "major": server_protocol["major"],
                "minor": server_protocol["minor"],
            },
            "clientCapabilities": {},
        },
    )
    init_resp = read_response(proc.stdout, init_req)
    if not init_resp.get("ok"):
        print(
            f"[python-cli] initialize failed: {init_resp.get('error')}; "
            "is the sidecar on protocol v1.3+?"
        )
        proc.stdin.close()
        proc.wait()
        sys.exit(1)
    server_caps = init_resp["result"].get("serverCapabilities", {})
    print(
        f"[python-cli] initialize OK: server={init_resp['result']['serverVersion']}, "
        f"protocol={init_resp['result']['protocolVersion']}, "
        f"methods={len(server_caps.get('methods', []))}"
    )

    # ── 3. List workspaces ───────────────────────────────────────────────
    req_id = send(proc.stdin, "workspace.list")
    resp = read_response(proc.stdout, req_id)
    assert resp.get("ok"), f"workspace.list failed: {resp}"
    print(f"[python-cli] workspace.list: {resp['result']}")

    # ── 4. Create a session ─────────────────────────────────────────────
    # session.create requires `workspace` (the cwd). Passing `initialPrompt`
    # both attaches the session and runs the first turn; without it the session
    # is created but not attached, and a later session.prompt would fail with
    # `invalid_state`.
    req_id = send(
        proc.stdin,
        "session.create",
        {"workspace": cwd, "initialPrompt": "hello"},
    )
    resp = read_response(proc.stdout, req_id)
    assert resp.get("ok"), f"session.create failed: {resp}"
    session_id = resp["result"]["sessionId"]
    print(f"[python-cli] session.create: sessionId={session_id}")

    # ── 5. Prompt on the attached session ──────────────────────────────
    # session.prompt is a long-running RPC; the server pushes session.event
    # frames before responding. read_response() prints those pushes and returns
    # only when the id-matched response arrives.
    req_id = send(
        proc.stdin,
        "session.prompt",
        {"workspace": cwd, "sessionId": session_id, "text": "echo ping"},
    )
    print("[python-cli] Waiting for session.prompt response…")
    resp = read_response(proc.stdout, req_id)
    assert resp.get("ok"), f"session.prompt error: {resp.get('error')}"
    print(f"[python-cli] session.prompt result: {resp['result']}")

    proc.stdin.close()
    proc.wait()
    print("[python-cli] done.")


if __name__ == "__main__":
    main()
