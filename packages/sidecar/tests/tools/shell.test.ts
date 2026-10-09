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
import { setTimeout } from "node:timers/promises";
import { runShell } from "../../src/tools/shell.ts";

// Traps SIGTERM so it does nothing, then busy-loops. Only SIGKILL (which
// cannot be trapped) can end it. A tight loop of short `sleep`s rather than
// one long `sleep N`: with `shell: true`, `sleep` runs as a grandchild of the
// spawned /bin/sh, and a shell stuck in a loop cannot `exec` itself away, so
// the signal reaches the process that is actually running at kill time.
const IGNORE_SIGTERM_AND_BUSY_LOOP = "trap '' TERM; while true; do sleep 0.1; done";

// A compound command: `/bin/sh` stays alive as the group leader and runs the
// `sleep` as a grandchild, which is the shape that used to leave the real
// process untouched and hold the inherited stdout pipe open.
const COMPOUND_COMMAND = "sleep 30 & wait";

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

    // Before the process-group kill, `runShell` awaited `close`, which needs
    // every inherited stdout/stderr pipe closed. The grandchild held them open,
    // so these calls only resolved once `sleep 30` finished on its own — a
    // timed-out or aborted compound command hung the tool, and any parent abort
    // awaiting it, for the full length of the command.
    if (process.platform !== "win32") {
        it("returns promptly when a compound command is killed by timeout", async () => {
            const started = Date.now();
            const result = await runShell(COMPOUND_COMMAND, null, {
                cwd: tmpdir(),
                timeoutMs: 50,
                sigkillDelayMs: 50,
            });
            assert.equal(result.details.interrupted, true);
            assert.ok(
                Date.now() - started < 5_000,
                `expected the grandchild to die with the process group, took ${Date.now() - started}ms`,
            );
        });

        it("returns promptly when a compound command is killed by abort", async () => {
            const controller = new AbortController();
            const started = Date.now();
            const pending = runShell(COMPOUND_COMMAND, null, {
                cwd: tmpdir(),
                signal: controller.signal,
                sigkillDelayMs: 50,
            });
            // Aborting synchronously would fire before `/bin/sh` has forked the
            // grandchild, leaving nothing for the process-group kill to catch —
            // the test would then pass with or without the fix.
            await setTimeout(200);
            controller.abort();
            const result = await pending;
            assert.equal(result.details.interrupted, true);
            assert.ok(
                Date.now() - started < 5_000,
                `expected the grandchild to die with the process group, took ${Date.now() - started}ms`,
            );
        });
    }
});
