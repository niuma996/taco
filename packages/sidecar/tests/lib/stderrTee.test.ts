/**
 * stderrTee tests — mirroring, failure detach, and install/dispose symmetry.
 *
 * Run:
 *   pnpm --filter @taco-ai/sidecar test:stderrTee
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installStderrTee } from "../../src/lib/stderrTee.ts";

let dir: string;
let logPath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taco-stderr-tee-"));
    logPath = join(dir, "daemon.err.log");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Swap in a capturing stderr.write, returning it plus a restore fn. */
function stubStderr(onWrite?: () => void): {
    chunks: string[];
    restore: () => void;
} {
    const original = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
    (process.stderr as any).write = (chunk: any): boolean => {
        onWrite?.();
        chunks.push(String(chunk));
        return true;
    };
    return {
        chunks,
        restore: () => {
            // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
            (process.stderr as any).write = original;
        },
    };
}

describe("installStderrTee", () => {
    it("returns undefined for an empty path so callers can skip the tee", () => {
        assert.equal(installStderrTee(""), undefined);
    });

    it("mirrors writes to both the log file and the original stderr", async () => {
        const cap = stubStderr();
        const handle = installStderrTee(logPath);
        assert.ok(handle);
        try {
            process.stderr.write("hello tee\n");
        } finally {
            // dispose() calls end(); the bytes only reach disk once the
            // stream flushes, which is what its promise settles on.
            await handle.dispose();
            cap.restore();
        }
        assert.deepEqual(cap.chunks, ["hello tee\n"]);
        assert.match(readFileSync(logPath, "utf8"), /hello tee/);
    });

    it("restores the original stderr.write on dispose", () => {
        const cap = stubStderr();
        const handle = installStderrTee(logPath);
        assert.ok(handle);
        const teed = process.stderr.write;
        handle.dispose();
        assert.notEqual(process.stderr.write, teed, "dispose should swap the tee back out");
        // Assert behaviour, not identity: the restored write is a bound copy
        // of the stub, so it can never be reference-equal to it.
        process.stderr.write("after dispose\n");
        cap.restore();
        assert.deepEqual(cap.chunks, ["after dispose\n"]);
        // Nothing was ever mirrored here, so the lazily-opened stream may not
        // exist at all; either way it must not have captured the post-dispose
        // write.
        const mirrored = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
        assert.equal(mirrored.includes("after dispose"), false);
    });

    it("is idempotent — a second dispose is a no-op", () => {
        const cap = stubStderr();
        const handle = installStderrTee(logPath);
        assert.ok(handle);
        handle.dispose();
        assert.doesNotThrow(() => handle.dispose());
        cap.restore();
    });

    // The regression this module exists for: once the launcher that spawned the
    // daemon exits, every stderr write throws EPIPE. If the tee re-enters the
    // error path it floods the log and wedges the event loop (observed: a 2.2 GB
    // daemon.err.log of one repeating stack while all RPC timed out).
    it("detaches instead of looping when the underlying stderr throws EPIPE", () => {
        let writes = 0;
        const original = process.stderr.write.bind(process.stderr);
        // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
        (process.stderr as any).write = (): boolean => {
            writes += 1;
            const err = new Error("write EPIPE") as Error & { code: string };
            err.code = "EPIPE";
            throw err;
        };
        const handle = installStderrTee(logPath);
        assert.ok(handle);
        try {
            assert.doesNotThrow(() => process.stderr.write("first\n"));
            for (let i = 0; i < 50; i += 1) process.stderr.write(`line ${i}\n`);
        } finally {
            handle.dispose();
            // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
            (process.stderr as any).write = original;
        }
        assert.equal(writes, 1, "underlying stderr must be attempted only once, then detached");
    });

    it("invokes the caller callback after detaching so writers never hang", () => {
        const original = process.stderr.write.bind(process.stderr);
        // biome-ignore lint/suspicious/noExplicitAny: matching Node's write overloads
        (process.stderr as any).write = (): boolean => {
            throw new Error("write EPIPE");
        };
        const handle = installStderrTee(logPath);
        assert.ok(handle);
        let called = 0;
        try {
            // First write trips the detach, second takes the already-detached path.
            process.stderr.write("trip\n", () => {
                called += 1;
            });
            process.stderr.write("after\n", () => {
                called += 1;
            });
        } finally {
            handle.dispose();
            // biome-ignore lint/suspicious/noExplicitAny: restoring the original binding
            (process.stderr as any).write = original;
        }
        assert.equal(called, 2, "both callbacks must fire even once detached");
    });

    // dispose() must remove the error listeners it added. Without this, ten
    // install/dispose rounds trip MaxListenersExceededWarning and a disposed
    // closure can still be flipped by a listener from a previous install.
    it("leaves no error listeners behind after dispose", () => {
        const cap = stubStderr();
        const baseline = process.stderr.listenerCount("error");
        for (let i = 0; i < 12; i += 1) {
            const handle = installStderrTee(logPath);
            assert.ok(handle);
            handle.dispose();
        }
        cap.restore();
        assert.equal(
            process.stderr.listenerCount("error"),
            baseline,
            "install/dispose cycles must not accumulate stderr error listeners",
        );
    });
});
