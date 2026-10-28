/**
 * stderrTee — install / remove a file mirror of `process.stderr`.
 *
 * Replaces `process.stderr.write` with a thin wrapper that forwards every
 * chunk to both the original stderr and one long-lived append fd written
 * synchronously. One fd, no per-call open, no queued buffers: a write either
 * lands before the call returns or marks the mirror broken, so rotation never
 * races a pending write.
 *
 * Failure isolation: once either side errors (mirror fs error, or
 * `EPIPE` after the launcher that spawned the daemon has exited and
 * closed the pipe), that direction detaches and subsequent writes drop
 * silently with the caller callback invoked. This is load-bearing —
 * without it, a single EPIPE wedges the event loop and floods the tee
 * log with the same stack frame forever (the launcher-close bug fixed
 * in 7ecfa65, where daemon.err.log reached 2.2 GB of repeating EPIPEs).
 *
 * Call `dispose()` before `process.exit` so the fd is closed and
 * `process.stderr.write` is restored.
 */

import { closeSync, openSync, renameSync, statSync, writeSync } from "node:fs";

type StderrWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
) => boolean;

export interface StderrTeeOptions {
    /**
     * Rotate the mirror to `<logPath>.1` (replacing the previous one) once it
     * reaches this many bytes. Unbounded when omitted.
     */
    maxBytes?: number;
    /**
     * Chunks starting with this prefix still reach the original stderr but are
     * kept out of the mirror. Used for `[taco:llm]` payload dumps: the desktop
     * routes those to its own opt-in file, and copying them here as well
     * made this log grow by whole request bodies.
     */
    skipPrefix?: string;
}

export interface StderrTeeHandle {
    /**
     * Detach the tee and close the mirror fd. Safe to call more than once.
     * Writes are synchronous, so the bytes are on disk once this returns; the
     * promise is kept for callers that already await it.
     */
    dispose(): Promise<void>;
    /** Path the mirror was opened against (for diagnostics). */
    readonly targetPath: string;
}

/**
 * Install a stderr tee. Returns a handle whose `dispose()` must be called
 * before `process.exit`; until then, all writes to `process.stderr` are
 * mirrored to `logPath`. No-op if `logPath` is empty.
 */
export function installStderrTee(
    logPath: string,
    options: StderrTeeOptions = {},
): StderrTeeHandle | undefined {
    if (!logPath) return undefined;
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const skipPrefix = options.skipPrefix;
    let origBroken = false;
    let written = 0;
    try {
        written = statSync(logPath).size;
    } catch {
        // Missing file: openSync below creates it.
    }
    let rotateAt = maxBytes;
    /**
     * Move the current file to `<logPath>.1`, replacing the previous one. The
     * caller closes the live append fd first so this also works on Windows.
     * On failure wait one more budget instead of retrying on every write.
     */
    const rotate = (): boolean => {
        try {
            renameSync(logPath, `${logPath}.1`);
        } catch {
            rotateAt = written + maxBytes;
            return false;
        }
        written = 0;
        rotateAt = maxBytes;
        return true;
    };
    // An oversized file left by an earlier run is moved aside, not appended to.
    if (written >= rotateAt) rotate();
    let fd: number | undefined;
    try {
        fd = openSync(logPath, "a");
    } catch {
        // Unwritable target: keep forwarding to stderr without a mirror.
    }
    const closeFd = (): void => {
        if (fd === undefined) return;
        try {
            closeSync(fd);
        } catch {
            // best-effort
        }
        fd = undefined;
    };
    const mirror = (chunk: string | Uint8Array): void => {
        if (fd === undefined) return;
        if (skipPrefix !== undefined && typeof chunk === "string" && chunk.startsWith(skipPrefix)) {
            return;
        }
        try {
            written += typeof chunk === "string" ? writeSync(fd, chunk) : writeSync(fd, chunk);
        } catch {
            // Disk full / fd revoked: drop the mirror for good rather than
            // erroring (and logging about it) on every subsequent write.
            closeFd();
            return;
        }
        if (written >= rotateAt) {
            // Windows cannot rename an open file. Close before every attempt,
            // then reopen whichever file remains after success or failure.
            closeFd();
            rotate();
            try {
                fd = openSync(logPath, "a");
            } catch {
                fd = undefined;
            }
        }
    };
    // Named so `dispose()` can remove it again. An anonymous listener would
    // accumulate across install/dispose cycles: ten rounds trips Node's
    // MaxListenersExceededWarning, and a stale listener from a previous
    // install can still flip this closure's `origBroken` after it was
    // disposed.
    const onStderrError = (): void => {
        origBroken = true;
    };
    process.stderr.on("error", onStderrError);
    const origWrite = process.stderr.write.bind(process.stderr);
    const tee: StderrWrite = (chunk, encodingOrCallback, callback) => {
        if (origBroken) {
            if (typeof encodingOrCallback === "function") encodingOrCallback();
            else if (typeof callback === "function") callback();
            return true;
        }
        mirror(chunk);
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
            closeFd();
            return Promise.resolve();
        },
    };
}
