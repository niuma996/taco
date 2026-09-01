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
    /**
     * Detach the tee and finalize the mirror stream. Safe to call more than
     * once. Returns a promise that settles when the stream has flushed —
     * `process.on("exit")` callers can ignore it (exit cannot await, so the
     * flush is best-effort there), but a caller that needs the bytes on disk
     * can await it.
     */
    dispose(): Promise<void>;
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
    // Named so `dispose()` can remove them again. Anonymous listeners would
    // accumulate across an install/dispose cycle: ten rounds trips Node's
    // MaxListenersExceededWarning, and a stale listener from a previous
    // install can still flip this closure's `origBroken` after it was
    // disposed.
    const onTeeError = (): void => {
        teeBroken = true;
    };
    const onStderrError = (): void => {
        origBroken = true;
    };
    teeStream.on("error", onTeeError);
    process.stderr.on("error", onStderrError);
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
        dispose(): Promise<void> {
            if (disposed) return Promise.resolve();
            disposed = true;
            process.stderr.write = origWrite;
            process.stderr.removeListener("error", onStderrError);
            teeStream.removeListener("error", onTeeError);
            // The stream is abandoned from here on, but `createWriteStream`
            // opens lazily: a stream disposed before its open() landed still
            // emits ENOENT/EACCES a tick later. With our own listener gone
            // that would reach the process as an uncaughtException, so leave
            // a swallowing listener in its place — attached to the abandoned
            // stream, not to `process.stderr`, so nothing accumulates
            // globally.
            teeStream.on("error", () => {});
            // end() finalizes; the actual fs write lands after this returns,
            // which is fine for the exit path because we only need the fd
            // released before the process image is replaced. Callers that
            // need the bytes readable can await the returned promise.
            return new Promise<void>((resolve) => {
                try {
                    teeStream.end(() => resolve());
                } catch {
                    // best-effort: stream may already be in a terminal state.
                    resolve();
                }
            });
        },
    };
}
