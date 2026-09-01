/**
 * stderrTee — install / remove a write-stream mirror of `process.stderr`.
 *
 * Replaces `process.stderr.write` with a thin wrapper that forwards every
 * chunk to both the original stderr and a single long-lived
 * `createWriteStream`. One fd, no per-call open, serializes internally.
 *
 * Failure isolation: once either side errors (tee stream fs error, or
 * `EPIPE` after the launcher that spawned the daemon has exited and
 * closed the pipe), that direction detaches and subsequent writes drop
 * silently with the caller callback invoked. This is load-bearing —
 * without it, a single EPIPE wedges the event loop and floods the tee
 * log with the same stack frame forever (the launcher-close bug fixed
 * in 7ecfa65, where daemon.err.log reached 2.2 GB of repeating EPIPEs).
 *
 * Call `dispose()` before `process.exit` so the stream's pending bytes
 * flush and `process.stderr.write` is restored. `process.on("exit")`
 * cannot await, so the flush is best-effort.
 */

import type { WriteStream } from "node:fs";
import { createWriteStream } from "node:fs";

type StderrWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
) => boolean;

export interface StderrTeeHandle {
    /** Synchronous best-effort flush + restore. Safe to call multiple times. */
    dispose(): void;
    /** Path the mirror stream was opened against (for diagnostics). */
    readonly targetPath: string;
}

/**
 * Install a stderr tee. Returns a handle whose `dispose()` must be called
 * before `process.exit`; until then, all writes to `process.stderr` are
 * mirrored to `logPath`. No-op if `logPath` is empty.
 */
export function installStderrTee(logPath: string): StderrTeeHandle | undefined {
    if (!logPath) return undefined;
    const teeStream: WriteStream = createWriteStream(logPath, { flags: "a" });
    let teeBroken = false;
    let origBroken = false;
    teeStream.on("error", () => {
        teeBroken = true;
    });
    process.stderr.on("error", () => {
        origBroken = true;
    });
    const origWrite = process.stderr.write.bind(process.stderr);
    const tee: StderrWrite = (chunk, encodingOrCallback, callback) => {
        if (origBroken) {
            if (typeof encodingOrCallback === "function") encodingOrCallback();
            else if (typeof callback === "function") callback();
            return true;
        }
        if (!teeBroken) {
            try {
                teeStream.write(chunk);
            } catch {
                teeBroken = true;
            }
        }
        try {
            return (origWrite as StderrWrite)(chunk, encodingOrCallback, callback);
        } catch {
            origBroken = true;
            if (typeof encodingOrCallback === "function") encodingOrCallback();
            else if (typeof callback === "function") callback();
            return true;
        }
    };
    process.stderr.write = tee;
    let disposed = false;
    return {
        targetPath: logPath,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            process.stderr.write = origWrite;
            // close() queues a graceful flush; end() finalizes. Both run
            // synchronously here but the actual fs write completes after
            // this returns — that's fine because we only need the fd
            // released before the process image is replaced.
            try {
                teeStream.end();
            } catch {
                // best-effort: stream may already be in a terminal state.
            }
        },
    };
}
