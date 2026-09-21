/**
 * runShell's SIGTERM→SIGKILL escalation.
 *
 * `child.killed` reflects whether a signal was successfully *delivered*, not
 * whether the process exited — `if (!child.killed)` right after calling
 * `child.kill("SIGTERM")` was always false, so the SIGKILL backstop never
 * fired for a child that ignores SIGTERM. These tests use a short
 * `sigkillDelayMs` so they don't wait out the real 5s escalation window.
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { runShell } from "../../src/tools/shell.ts";

// Traps SIGTERM so it does nothing, then busy-loops. Only SIGKILL (which
// cannot be trapped) can end it. A tight loop of short `sleep`s rather than
// one long `sleep N`: with `shell: true`, `sleep` runs as a grandchild of the
// spawned /bin/sh, and SIGKILL sent to the shell does not reach a grandchild
// that is already blocked in its own syscall (a separate, known process-group
// gap — see subagent stop notes). A `sleep 0.1` loop keeps the process that
// receives the signal (the shell) the one actually running at kill time.
const IGNORE_SIGTERM_AND_BUSY_LOOP = "trap '' TERM; while true; do sleep 0.1; done";

describe("runShell — SIGTERM→SIGKILL escalation", () => {
    it("SIGKILLs a child that ignores SIGTERM after a timeout", async () => {
        const result = await runShell(IGNORE_SIGTERM_AND_BUSY_LOOP, null, {
            cwd: tmpdir(),
            timeoutMs: 50,
            sigkillDelayMs: 50,
        });
        assert.equal(result.details.interrupted, true);
        // What matters here is that the promise resolved at all: before the
        // fix, `if (!child.killed)` was always false right after
        // `child.kill("SIGTERM")`, so the SIGKILL escalation below it never
        // ran, and a child that traps SIGTERM would hang this call forever.
    });

    it("SIGKILLs a child that ignores SIGTERM after an abort signal", async () => {
        const controller = new AbortController();
        const pending = runShell(IGNORE_SIGTERM_AND_BUSY_LOOP, null, {
            cwd: tmpdir(),
            signal: controller.signal,
            sigkillDelayMs: 50,
        });
        controller.abort();
        const result = await pending;
        assert.equal(result.details.interrupted, true);
    });
});
