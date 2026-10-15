/**
 * Replayed-response gate for `command: true` RPCs.
 *
 * Owns three concerns that share one TTL budget:
 *   1. outcome caching — a retry with the same commandId and the same
 *      params replays the original outcome instead of re-executing;
 *   2. conflict rejection — the same commandId with different params is
 *      a `command_id_conflict`, not a replay;
 *   3. the one-active-turn-per-session gate (`turnStart: true` methods).
 *
 * Split out of `SidecarServer` because this is a self-contained
 * cache/concurrency policy with zero knowledge of workspaces, channels,
 * or sessions — the caller supplies key/fingerprint strings and an
 * executor, and converts the returned markers into wire error frames
 * (their message strings are client-facing contract, asserted verbatim
 * by `commandIdempotency.test.ts`).
 */

import { performance } from "node:perf_hooks";
import type { CommandOutcome } from "./rpcResponse.ts";

interface CommandRecord {
    fingerprint: string;
    outcome: Promise<CommandOutcome>;
    settled: boolean;
    /** Monotonic deadline: created_at + ttlMs. */
    expiresAt: number;
}

export interface CommandIdempotencyOptions {
    /**
     * How long a command outcome stays eligible for idempotent replay.
     * Guarded to >= 1: a 0 / negative TTL would be permanently expired
     * (records unusable) and setInterval(<=0) would busy-spin the sweeper.
     */
    ttlMs?: number;
    /** Maximum number of settled command outcomes retained; values below 1 clamp to 1. */
    limit?: number;
    /** Monotonic clock for TTL decisions. Defaults to performance.now(). */
    now?: () => number;
}

/** Default idempotency window for command outcomes. */
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_LIMIT = 1024;

export class CommandIdempotencyGate {
    private readonly records = new Map<string, CommandRecord>();
    private readonly activeTurns = new Map<string, Promise<CommandOutcome>>();
    private readonly ttlMs: number;
    private readonly limit: number;
    private readonly now: () => number;
    private sweeper?: ReturnType<typeof setInterval>;

    constructor(options: CommandIdempotencyOptions = {}) {
        this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
        this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
        this.now = options.now ?? (() => performance.now());
    }

    /** Retained records — observable for tests and cache-pressure logging. */
    get size(): number {
        return this.records.size;
    }

    /**
     * Periodic TTL sweep: guarantees the map cannot grow unbounded even
     * when no new RPC ever arrives (the original leak). unref so a
     * long-running sidecar can still exit. Trade-off: sweeping at exactly
     * the TTL means a record can linger up to ~2×TTL worst case (expired
     * just after a sweep ran).
     */
    startSweeper(): void {
        this.stopSweeper();
        this.sweeper = setInterval(() => this.prune(), this.ttlMs);
        this.sweeper.unref();
    }

    /**
     * Drop all state (records, active-turn table, sweeper). The
     * active-turn table only drops a key when its outcome settles — a
     * turn interrupted by stop() never settles, so without this clear a
     * restarted server would answer `session_busy` for that session
     * forever.
     */
    stop(): void {
        this.records.clear();
        this.activeTurns.clear();
        this.stopSweeper();
    }

    prune(): void {
        const now = this.now();
        // Expired records never count toward the limit and are freed
        // eagerly even when every survivor is in-flight — this is what
        // bounds the map when a handler never settles.
        for (const [key, record] of this.records) {
            if (now >= record.expiresAt) this.records.delete(key);
        }
        while (this.records.size > this.limit) {
            const oldestSettled = [...this.records.entries()].find(
                ([, record]) => record.settled,
            )?.[0];
            if (!oldestSettled) return;
            this.records.delete(oldestSettled);
        }
    }

    /**
     * Check idempotency and the turn gate, run `exec` on a miss, and
     * track the outcome. Returns the (possibly cached) outcome promise,
     * or a marker the caller converts into an error frame — this module
     * does not know RpcResponse shapes.
     */
    run(
        key: string,
        fingerprint: string,
        turnKey: string | undefined,
        exec: () => Promise<CommandOutcome>,
    ): Promise<CommandOutcome> | "conflict" | "busy" {
        const existing = this.records.get(key);
        if (existing) {
            // Lazy TTL expiry: a stale record is treated as absent so a
            // retry re-executes (idempotency window expired). Never
            // touches outcome — the original request is still awaiting it.
            if (this.now() >= existing.expiresAt) {
                this.records.delete(key);
            } else if (existing.fingerprint !== fingerprint) {
                return "conflict";
            } else {
                return existing.outcome;
            }
        }

        if (turnKey && this.activeTurns.has(turnKey)) {
            return "busy";
        }

        const outcome = exec();
        const record: CommandRecord = {
            fingerprint,
            outcome,
            settled: false,
            expiresAt: this.now() + this.ttlMs,
        };
        this.records.set(key, record);
        void outcome.then(() => {
            record.settled = true;
            this.prune();
        });
        if (turnKey) {
            this.activeTurns.set(turnKey, outcome);
            void outcome.finally(() => {
                if (this.activeTurns.get(turnKey) === outcome) {
                    this.activeTurns.delete(turnKey);
                }
            });
        }
        return outcome;
    }

    private stopSweeper(): void {
        if (this.sweeper) {
            clearInterval(this.sweeper);
            this.sweeper = undefined;
        }
    }
}
