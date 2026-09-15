/**
 * Durable disk tail for sequenced session push frames — one JSONL file per
 * (workspace, session) stream under `<root>/<sessionId>-<workspaceHash>.jsonl`.
 *
 * Why: `SessionEventLog`'s ring is process-local. When the sidecar restarts
 * while a desktop client stays up, the client's cursor sits at a high seq
 * while the new process restarts at 1 — every subsequent frame is discarded
 * as a duplicate and the session view freezes. Hydrating the ring from this
 * tail (`SessionEventLog.hydrate`) restores seq continuity so reconnecting
 * clients replay instead of rebuilding from a full snapshot.
 *
 * The file key mirrors the ring's key exactly. Keying on `sessionId` alone
 * would let two workspaces that share a session id (clients may supply their
 * own id to `session.create`) collide on one file while their rings stay
 * separate — one stream's seqs would then hydrate the other's.
 *
 * ## One writer per stream
 *
 * Seq numbering lives in the ring, not here, so two `SessionEventLog`s
 * appending to one file interleave two independent seq sequences and hydrate
 * would adopt whichever landed last. Two invariants keep that from happening:
 *
 *  - **One instance per process.** A daemon runs several `SidecarServer`s
 *    (see `SharedSidecarDeps.pushLog`); they share this object so its
 *    per-file chain serializes every append and compaction. Separate
 *    instances would race on the read-merge-rename compaction path.
 *  - **Only client-observed streams get a tail.** A server whose frames no
 *    client can see (the daemon's scheduler sidecar, which pushes into a
 *    `NullTransport`) is constructed without a `pushLog`: it has no client
 *    cursor to preserve, and writing its ring's seqs into a desktop's tail
 *    would corrupt exactly the continuity this file exists to provide.
 *
 * Best-effort by contract: appends are buffered and flushed on a short
 * timer, and a crash may lose the unflushed window or tear the last line.
 * Both degrade to the pre-existing `resetRequired` snapshot path, never to
 * silent seq reuse — `loadTail` only returns complete, parseable lines.
 * `flush()` drains the buffer on graceful shutdown so the common
 * restart-by-the-user case loses nothing.
 *
 * The file is bounded: when it exceeds `maxFileBytes` the flush path
 * rewrites it with only the most recent `keep` lines (same bound as the
 * in-memory ring), so a long session never grows an unbounded tail.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerPush, SessionId, WorkspaceId } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("sidecar.durablePushLog");

const DEFAULT_FLUSH_DELAY_MS = 25;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_KEEP = 512;

export interface DurablePushLogOptions {
    /** Buffered flush window; a crash may lose at most this much. */
    flushDelayMs?: number;
    /** Rewrite (compact) a session file once it exceeds this size. */
    maxFileBytes?: number;
    /** Lines kept after compaction — mirror of the ring capacity. */
    keep?: number;
}

interface FileState {
    pending: string[];
    timer?: ReturnType<typeof setTimeout>;
    /** Serializes every mutation/read of this stream's file. */
    chain: Promise<void>;
    /** Streams probed but absent on disk — skip repeat ENOENT reads. */
    missing?: boolean;
    /**
     * The one ring allowed to append to this stream. Set on first append (or
     * first `loadTail`) and never reassigned while the claim is held; frames
     * from any other ring are dropped. See `claimedBy` on the class.
     */
    owner?: object;
}

export class DurablePushLog {
    private readonly root: string;
    private readonly flushDelayMs: number;
    private readonly maxFileBytes: number;
    private readonly keep: number;
    private readonly files = new Map<string, FileState>();
    private readonly warnedStreams = new Set<string>();

    constructor(root: string, options: DurablePushLogOptions = {}) {
        this.root = root;
        this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
        this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        this.keep = options.keep ?? DEFAULT_KEEP;
    }

    /**
     * Buffer one frame; the timer batches high-frequency streaming pushes.
     *
     * `owner` identifies the calling ring. The first caller to touch a stream
     * claims it; frames from a second ring are dropped rather than interleaved,
     * because each ring numbers seqs independently and a mixed tail would
     * hydrate a restarted server to a sequence that never existed. Dropping is
     * safe: the loser's client falls back to snapshot recovery, which is the
     * behaviour it had before any tail existed.
     */
    scheduleAppend(event: ServerPush, owner: object): void {
        // Only session-scoped frames carry a seq (SessionEventLog.append only
        // sees those); skip anything else defensively.
        if (!event.session) return;
        const key = streamKey(event.workspace, event.session);
        const state = this.stateFor(key);
        if (!this.claim(key, state, owner)) return;
        state.pending.push(JSON.stringify(event));
        if (!state.timer) {
            state.timer = setTimeout(() => {
                const s = this.files.get(key);
                if (s) s.timer = undefined;
                void this.enqueue(key, () => this.flushSync(key));
            }, this.flushDelayMs);
            state.timer.unref?.();
        }
    }

    /**
     * Read the last `limit` frames for a stream. Torn final lines (crash
     * mid-append) are truncated away and the file is repaired in place so a
     * later append cannot weld new JSON onto the broken line. Returns [] when
     * the stream has no tail (including "probed and absent" short-circuit).
     */
    async loadTail(
        workspace: WorkspaceId,
        session: SessionId,
        limit: number,
        owner: object,
    ): Promise<ServerPush[]> {
        const key = streamKey(workspace, session);
        const state = this.stateFor(key);
        // Hydrating means this ring is about to continue the stream, so it must
        // hold the append claim — otherwise it would adopt the tail's seqs and
        // then be silently unable to extend it.
        if (!this.claim(key, state, owner)) return [];
        if (state.missing) return [];
        return this.enqueue(key, async () => {
            // Flush the buffer first so the tail read includes frames that
            // have not hit their timer yet (e.g. append → hydrate in tests).
            await this.flushSync(key);
            const raw = await readFile(this.pathFor(key), "utf8").catch(
                (error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") {
                        state.missing = true;
                        return "";
                    }
                    throw error;
                },
            );
            if (raw === "") return [];
            const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
            if (complete !== raw) {
                // Repair the torn line before any later append lands after it.
                await writeFile(this.pathFor(key), complete, "utf8");
            }
            const frames: ServerPush[] = [];
            for (const line of complete.split("\n")) {
                if (line === "") continue;
                try {
                    const parsed = JSON.parse(line) as ServerPush;
                    if (typeof parsed.seq === "number") frames.push(parsed);
                } catch {
                    // Unparseable interior line: skip, keep the rest.
                }
            }
            return frames.slice(-limit);
        });
    }

    /**
     * Drop a deleted stream's tail and any buffered frames.
     *
     * `pending` is cleared before the unlink is enqueued so a frame buffered
     * for a now-deleted session cannot be flushed into a file that the unlink
     * has already passed, leaving a resurrected one-line tail behind.
     */
    remove(workspace: WorkspaceId, session: SessionId): void {
        const key = streamKey(workspace, session);
        const state = this.stateFor(key);
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
        state.pending = [];
        state.missing = false;
        // The stream is gone; a future session reusing this key starts fresh.
        state.owner = undefined;
        this.warnedStreams.delete(key);
        void this.enqueue(key, () =>
            unlink(this.pathFor(key)).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") log.warn("failed to remove push tail", { error });
            }),
        );
    }

    /**
     * Drain every buffered frame to disk and await the result.
     *
     * Called on graceful shutdown: without it a clean restart still drops the
     * last flush window, which is the exact moment seq continuity matters most
     * (the user restarting the sidecar with the desktop still open). Forces a
     * flush rather than only awaiting the chain — buffered lines whose timer
     * has not fired yet are not in the chain at all.
     */
    async flush(): Promise<void> {
        await Promise.all(
            [...this.files.keys()].map((key) =>
                this.enqueue(key, () => this.flushSync(key)).catch(() => undefined),
            ),
        );
    }

    /**
     * Grant `owner` the stream's append claim, or report that someone else
     * already holds it. Warns once per stream so a second desktop opening the
     * same session is diagnosable without flooding the log for every frame.
     */
    private claim(key: string, state: FileState, owner: object): boolean {
        state.owner ??= owner;
        if (state.owner === owner) return true;
        if (!this.warnedStreams.has(key)) {
            this.warnedStreams.add(key);
            log.warn(
                "push tail already claimed by another session log; skipping durable writes for this stream",
                { stream: key },
            );
        }
        return false;
    }

    /**
     * Release every claim held by `owner` — called when a server stops, so a
     * reconnecting client can take over the stream instead of being locked out
     * by the dead connection's claim.
     */
    releaseOwner(owner: object): void {
        for (const [key, state] of this.files) {
            if (state.owner !== owner) continue;
            state.owner = undefined;
            this.warnedStreams.delete(key);
        }
    }

    private stateFor(key: string): FileState {
        let state = this.files.get(key);
        if (!state) {
            state = { pending: [], chain: Promise.resolve() };
            this.files.set(key, state);
        }
        return state;
    }

    /** Serialize one operation after this stream file's pending work. */
    private enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
        const state = this.stateFor(key);
        const run = state.chain.then(op, op);
        state.chain = run.then(
            () => undefined,
            (error: unknown) => {
                log.warn("push tail operation failed", { stream: key, error });
            },
        );
        return run;
    }

    private async flushSync(key: string): Promise<void> {
        const state = this.files.get(key);
        if (!state || state.pending.length === 0) return;
        const lines = state.pending;
        state.pending = [];
        const path = this.pathFor(key);
        await mkdir(this.root, { recursive: true });
        state.missing = false;
        let size = 0;
        try {
            size = (await stat(path)).size;
        } catch {
            size = 0;
        }
        const batch = `${lines.join("\n")}\n`;
        if (size + batch.length > this.maxFileBytes) {
            // Compact: keep only the most recent `keep` lines across the
            // existing file plus this batch. Temp file + rename keeps the
            // replacement atomic against concurrent readers.
            const existing = await readFile(path, "utf8").catch(() => "");
            const merged = [...parseLines(existing), ...lines];
            const kept = merged.slice(-this.keep);
            const tmp = `${path}.tmp`;
            await writeFile(tmp, `${kept.join("\n")}\n`, "utf8");
            await rename(tmp, path);
            return;
        }
        await writeFile(path, batch, { encoding: "utf8", flag: "a" });
    }

    private pathFor(key: string): string {
        return join(this.root, `${key}.jsonl`);
    }
}

/**
 * Filename-safe key for one (workspace, session) stream. The session id leads
 * so the directory stays greppable by session; the workspace contributes a
 * short hash because it is an absolute path (or an `im://` URL) and cannot go
 * into a filename verbatim. 12 hex chars of SHA-256 — collisions here would
 * merely merge two streams' tails, and a merged tail is discarded by the
 * client's `resetRequired` path rather than misapplied.
 */
function streamKey(workspace: WorkspaceId, session: SessionId): string {
    const safeSession = session.replace(/[^a-zA-Z0-9._-]/g, "_");
    const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
    return `${safeSession}-${hash}`;
}

function parseLines(raw: string): string[] {
    return raw
        .split("\n")
        .filter((line) => line !== "")
        .filter((line) => {
            try {
                JSON.parse(line);
                return true;
            } catch {
                return false;
            }
        });
}
