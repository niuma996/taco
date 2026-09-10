"""stdio_smoke.py — minimal NDJSON stdio smoke test for taco-sidecar.

Drives a real sidecar through the protocol surface without touching
LLM state. Designed for CI smoke checks where spawning an LLM turn
would be wasteful and flaky.

Sequence:
  spawn sidecar (via $TACO_SIDECAR_CMD or PATH)
  → initialize (mandatory in protocol v2+)
  → workspace.list
  → workspace.ensure
  → session.list
  → close stdin and wait for clean exit

Sidecar resolution follows the same rules as the full client:
  - $TACO_SIDECAR_CMD (split on whitespace) overrides PATH lookup
  - falls back to `taco-sidecar` on PATH

Usage:
    python3 examples/snippets/stdio_smoke.py [cwd]
"""

import json
import os
import subprocess
import sys
import uuid


def send(writer, method: str, params=None) -> str:
    rid = str(uuid.uuid4())
    writer.write(json.dumps({"id": rid, "method": method, "params": params or {}}) + "\n")
    writer.flush()
    return rid


def read_response(fd, rid: str) -> dict:
    while True:
        line = fd.readline()
        if not line:
            raise EOFError("sidecar closed stdout")
        line = line.strip()
        if not line:
            continue
        frame = json.loads(line)
        if frame.get("id") == rid and "ok" in frame:
            return frame


def main() -> int:
    cwd = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    cmd = os.environ.get("TACO_SIDECAR_CMD", "taco-sidecar").split()
    if os.environ.get("TACO_SIDECAR_ARGS"):
        cmd += os.environ["TACO_SIDECAR_ARGS"].split()

    print(f"[stdio_smoke] spawn: {' '.join(cmd)} (cwd={cwd})")
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        text=True,
    )

    try:
        init = read_response(proc.stdout, send(proc.stdin, "initialize", {
            "protocolVersion": {"major": 2, "minor": 0},
            "clientCapabilities": {},
        }))
        assert init.get("ok"), f"initialize failed: {init}"
        result = init["result"]
        print(
            f"[stdio_smoke] initialize: server={result['serverVersion']} "
            f"protocol={result['protocolVersion']['major']}.{result['protocolVersion']['minor']} "
            f"pid={result.get('pid')} instance={result.get('instanceId', '')[:8]}"
        )

        wl = read_response(proc.stdout, send(proc.stdin, "workspace.list"))
        assert wl.get("ok"), f"workspace.list failed: {wl}"
        print(f"[stdio_smoke] workspace.list: {wl['result']}")

        we = read_response(proc.stdout, send(proc.stdin, "workspace.ensure", {"cwd": cwd}))
        assert we.get("ok"), f"workspace.ensure failed: {we}"
        print(f"[stdio_smoke] workspace.ensure: cwd={we['result'].get('cwd')}")

        sl = read_response(proc.stdout, send(proc.stdin, "session.list", {"workspace": cwd}))
        assert sl.get("ok"), f"session.list failed: {sl}"
        sessions = sl["result"].get("sessions", []) or []
        print(f"[stdio_smoke] session.list: {len(sessions)} session(s)")

        return 0
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        err = proc.stderr.read().strip()
        if err:
            print(f"[stdio_smoke] stderr: {err}")


if __name__ == "__main__":
    sys.exit(main())
