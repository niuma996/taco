/** CompactionController — auto-compaction scheduling + manual compaction entry point. */

import { performance } from "node:perf_hooks";
import {
    type AgentHarness,
    type AgentLane,
    DEFAULT_COMPACTION_SETTINGS,
    type Entry,
    type ExecutionToolContext,
    shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { CompactionFailureReason, SessionCompactResult } from "@taco-ai/protocol";
import { DEFAULT_COMPACTION_ENABLED, DEFAULT_COMPACTION_THRESHOLD } from "@taco-ai/protocol";
import {
    type ResolvedCompaction,
    readGlobalConfig,
    validateCompactionConfig,
} from "../config/config.ts";
import { waitForEvent } from "../lib/async.ts";
import { harnessContext } from "../lib/harnessContext.ts";
import { createLogger } from "../lib/logger.ts";
import type { ContextUsage } from "./contextInfoService.ts";
import { isBusyError, toHarnessError } from "./harnessErrors.ts";
import type { PinOnceConsumer } from "./pinOnceConsumer.ts";

const log = createLogger("compactionController");

/**
 * Reads the resolved global compaction config from disk / CLI.
 * Injection point: tests can swap in a spy to count readFileSync calls;
 * production code uses the default `readGlobalConfig`.
 */
export type ReadGlobalConfig = () => ReturnType<typeof readGlobalConfig>;

/**
 * Monotonic clock source. `performance.now()` is immune to system-time
 * backwards jumps (NTP slew, manual clock change, leap second); `Date.now()`
 * would risk "cache never expires after the clock is moved backward".
 * Injection point: tests can swap a fake clock; production code uses
 * `performance.now()`.
 */
export type Now = () => number;

/**
 * Compaction lifecycle signal. Emitted as a strictly paired start/end around
 * every `harness.compact()` call so downstream consumers (the push adapter's
 * in-flight map, the desktop input freeze) can never be left latched on.
 *
 * pi 0.85 does emit `compaction_start` and `compaction_end` on the same event
 * bus, but the sidecar's existing pair is kept for two reasons:
 *
 *   1. `tokensBefore` is not carried inline on `compaction_end`; the controller
 *      resolves it via `getEntry(startEntryId)` so the push layer can show it.
 *   2. A throw from `harness.compact()` never fires pi's `compaction_end`, so
 *      the `finally` that emits our end signal is the only guarantee that a
 *      started compaction is always followed by an end — same pair discipline
 *      the prior comment described, but driven by our error path now, not by
 *      a bus asymmetry.
 */
export type CompactionLifecycleSignal =
    | { phase: "start"; tokensBefore: number }
    /**
     * `reason` is set only when `harness.compact()` threw. A clean return still
     * ends with `reason: undefined` — the adapter decides success by whether a
     * `session_compact` event committed a summary, not by this field.
     */
    | { phase: "end"; reason?: CompactionFailureReason };

/**
 * Map a compaction failure onto the wire-visible failure reason.
 *
 * pi 0.85 returns these as tagged errors rather than throwing a coded
 * `AgentHarnessError`, so classification reads `_tag` instead of `code`:
 *
 *   - `LaneBusy`         → busy (an operation is already running)
 *   - `NothingToCompact` → nothing (below the cut point)
 *   - a declining hook   → cancelled (no dedicated tag; see below)
 *
 * A `before_compaction` hook returning `{decline: true}` is not an error in
 * 0.85 — `compact()` succeeds with `declined` status, handled at the call site.
 * The `cancelled` reason survives here for pre-0.85 sessions and test doubles
 * that still surface a cancelling hook as a rejection.
 */
function classifyCompactFailure(e: unknown): CompactionFailureReason {
    if (isBusyError(e)) return "busy";
    const tag = (e as { _tag?: unknown } | null)?._tag;
    if (tag === "NothingToCompact") return "nothing";
    const message = e instanceof Error ? e.message : String(e);
    if (/nothing to compact/i.test(message)) return "nothing";
    if (/cancel/i.test(message)) return "cancelled";
    return "harness_error";
}

/**
 * Internal `session.event` type names carrying the lifecycle signal from
 * AttachedSession to CompactionPushAdapter. Sidecar-internal — the adapter
 * consumes them and never forwards the raw event, so they stay off the wire.
 * Prefixed to avoid colliding with any pi event type.
 */
export const COMPACTION_START_EVENT = "taco_compaction_start";
export const COMPACTION_END_EVENT = "taco_compaction_end";

export interface CompactionControllerOptions {
    /** Owns the event bus the controller subscribes to. */
    harness: AgentHarness<ExecutionToolContext>;
    /** Owns `compact()` and the idle signal. */
    lane: AgentLane;
    /** Injected compaction policy (undefined falls back to enabled=true/threshold=0.7). */
    compaction?: ResolvedCompaction;
    /** Shared context-usage read path — supplied by ContextInfoService to avoid duplicated buildContext. */
    getContextUsage: () => Promise<ContextUsage>;
    /** PinOnceConsumer — updates its consumed set when a compaction completes. */
    pinOnceConsumer?: PinOnceConsumer;
    /** Get current session's branch entries — used to update PinOnceConsumer. */
    getSessionEntries: () => Promise<Entry[]>;
    /**
     * Read one entry by id. Used to recover the committed compaction entry's
     * `tokensBefore` / `fromHook`, which pi 0.85's `compaction_end` event no
     * longer carries inline.
     */
    getEntry: (id: string) => Promise<Entry | undefined>;
    /**
     * Injected global-config reader — primarily for tests; production uses the default
     * `readGlobalConfig`. Lets `effectiveCompaction()` be tested without mocking `node:fs`.
     */
    readGlobalConfig?: ReadGlobalConfig;
    /**
     * TTL (ms) for `effectiveCompaction()`. Production passes nothing and uses
     * `EFFECTIVE_TTL_MS`. Tests can pass a small value (e.g. 50) to avoid real
     * wall-clock waits — same injection pattern as `readGlobalConfig`.
     */
    effectiveTtlMs?: number;
    /**
     * Injected clock source — tests can swap a fake clock; production uses
     * `performance.now()`. Monotonic to avoid system-time jumps invalidating
     * the cache-expiry check.
     */
    now?: Now;
    /**
     * Paired compaction lifecycle sink. Supplied by AttachedSession, which
     * forwards each signal onto the `session.event` stream. Absent in tests
     * that do not exercise the push path.
     */
    onLifecycle?: (signal: CompactionLifecycleSignal) => void;
}

/**
 * TTL cache duration (ms) for `effectiveCompaction()`. Each call reads
 * `~/.taco/taco.json` from disk, and the function is hot — invoked by
 * `maybeCompact()` on every `run_end` and by `getCompactionThreshold` on every
 * context build / `session_before_compact`. 1s covers 99% of "user changed
 * the threshold and immediately starts the next turn" scenarios; explicit
 * `invalidate()` (triggered by `settings.write`) makes user edits visible
 * nanoseconds after the write.
 */
const EFFECTIVE_TTL_MS = 1_000;

export class CompactionController {
    private readonly harness: AgentHarness<ExecutionToolContext>;
    private readonly lane: AgentLane;
    private readonly compaction: ResolvedCompaction | undefined;
    private readonly getContextUsage: () => Promise<ContextUsage>;
    private readonly pinOnceConsumer?: PinOnceConsumer;
    private readonly getSessionEntries: () => Promise<Entry[]>;
    private readonly getEntry: (id: string) => Promise<Entry | undefined>;
    private readonly readGlobalConfig: ReadGlobalConfig;
    private readonly effectiveTtlMs: number;
    private readonly now: Now;
    private readonly onLifecycle?: (signal: CompactionLifecycleSignal) => void;
    /**
     * Serialized auto-compaction-check promise. Each `run_end` event chains onto
     * the current run; does not block the caller, and an error in one run never
     * propagates to the UI.
     */
    private compactionCheck: Promise<void> = Promise.resolve();
    /**
     * Short-TTL cache for `effectiveCompaction()`. `undefined` means not cached
     * or invalidated. The `settings.write` handler invalidates after writing,
     * so steady state has zero disk reads and user changes take effect on
     * the very next call.
     */
    private cachedEffective: { value: ResolvedCompaction; expiresAt: number } | undefined;

    constructor(opts: CompactionControllerOptions) {
        this.harness = opts.harness;
        this.lane = opts.lane;
        this.compaction = opts.compaction;
        this.getContextUsage = opts.getContextUsage;
        this.pinOnceConsumer = opts.pinOnceConsumer;
        this.getSessionEntries = opts.getSessionEntries;
        this.getEntry = opts.getEntry;
        this.readGlobalConfig = opts.readGlobalConfig ?? readGlobalConfig;
        this.effectiveTtlMs = opts.effectiveTtlMs ?? EFFECTIVE_TTL_MS;
        this.now = opts.now ?? (() => performance.now());
        this.onLifecycle = opts.onLifecycle;
    }

    /**
     * Run `harness.compact()` bracketed by a paired lifecycle start/end.
     * `finally` is the pairing guarantee — every path out of `compact()`
     * (hook cancel, summary failure, `session_compact` never emitted, busy)
     * still emits `end`, so a consumer's in-flight state cannot latch.
     *
     * A lifecycle-sink throw must not turn into a compaction failure, hence
     * the guards around each emit.
     */
    private async runCompact(customInstructions?: string): Promise<void> {
        const tokensBefore = await this.readTokensBefore();
        try {
            this.onLifecycle?.({ phase: "start", tokensBefore });
        } catch (e) {
            log.error("compaction lifecycle start sink threw:", e);
        }
        let reason: CompactionFailureReason | undefined;
        try {
            const result = await this.lane.compact(
                customInstructions === undefined ? undefined : { customInstructions },
                harnessContext,
            );
            if (!result.ok) throw toHarnessError("compact", result.error);
            const status = result.value.compaction.status;
            if (status !== "completed") {
                // `declined` means a `before_compaction` hook refused; `aborted`
                // and `failed` speak for themselves. None of them throw in 0.85,
                // so the reason has to be derived from the operation record.
                reason = status === "declined" ? "cancelled" : "harness_error";
            }
        } catch (e) {
            // Classify before rethrowing so the `end` signal can carry a
            // machine-readable reason; callers still see the original error.
            reason = classifyCompactFailure(e);
            throw e;
        } finally {
            try {
                this.onLifecycle?.({ phase: "end", ...(reason ? { reason } : {}) });
            } catch (e) {
                log.error("compaction lifecycle end sink threw:", e);
            }
        }
    }

    /**
     * Best-effort pre-compaction token estimate for the `start` signal.
     * Never throws — the interlock matters, the number is cosmetic.
     */
    private async readTokensBefore(): Promise<number> {
        try {
            return (await this.getContextUsage()).usedTokens;
        } catch {
            return 0;
        }
    }

    /**
     * Returns the currently effective compaction settings.
     * Precedence: on-disk `taco.json` > injected (CLI override) > built-in default.
     * TTL cache: repeated calls within `effectiveTtlMs` (default 1s) hit cache.
     * The `settings.write` handler calls `invalidate()` after writing.
     */
    effectiveCompaction(): ResolvedCompaction {
        const now = this.now();
        if (this.cachedEffective && this.cachedEffective.expiresAt > now) {
            return this.cachedEffective.value;
        }
        const injected = this.compaction;
        let onDisk: ResolvedCompaction | undefined;
        try {
            onDisk = validateCompactionConfig(this.readGlobalConfig().compaction, "taco.json");
        } catch (e) {
            // On-disk value is broken — log it, fall back to injected / default, do not block the decision.
            log.error("effectiveCompaction: bad on-disk config:", e);
        }
        const value: ResolvedCompaction = {
            enabled: onDisk?.enabled ?? injected?.enabled ?? DEFAULT_COMPACTION_ENABLED,
            threshold: onDisk?.threshold ?? injected?.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
        };
        // Freeze before caching: cache hits return the reference (zero copy), callers can't mutate it.
        Object.freeze(value);
        this.cachedEffective = { value, expiresAt: now + this.effectiveTtlMs };
        return value;
    }

    /**
     * Explicitly invalidate the TTL cache for `effectiveCompaction()`.
     *
     * Called by the `settings.write` handler after writing the compaction
     * field, so a user threshold change in Settings is reflected by the very
     * next `effectiveCompaction()` call (no waiting for TTL).
     */
    invalidate(): void {
        this.cachedEffective = undefined;
    }

    /**
     * Subscribe to the harness events this controller reacts to. Returns one
     * disposer per subscription for the caller to release on detach.
     *
     * Two triggers:
     *  - `run_end` → schedule an auto-compaction check (deferred via
     *    `lane.runWhenIdle` so it cannot race a queued steer / follow-up
     *    turn, and also covers compaction and navigation operations)
     *  - `compaction_end` → refresh PinOnceConsumer
     */
    subscribe(): Array<() => void> {
        const disposers: Array<() => void> = [];

        disposers.push(
            this.harness.events.on("run_end", () => {
                this.scheduleCompactionCheck();
            }),
        );

        disposers.push(
            this.harness.events.on("compaction_end", () => {
                // Update PinOnceConsumer consumed set so context hooks skip re-injection.
                if (!this.pinOnceConsumer) return;
                const consumer = this.pinOnceConsumer;
                this.getSessionEntries()
                    .then((entries) => {
                        consumer.mergeConsumed(entries);
                    })
                    .catch(() => undefined);
            }),
        );

        return disposers;
    }

    /**
     * Serialized auto-compaction check. Multiple `run_end` events queue in
     * order; one failed compaction does not interrupt later checks.
     * Internal fire-and-forget — does not block `prompt()`.
     *
     * The check runs via `lane.runWhenIdle` so it cannot race a queued steer /
     * follow-up turn: pi holds the callback until the lane is genuinely idle,
     * which is also what makes `compact()` safe to call from here.
     */
    private scheduleCompactionCheck(): void {
        const next = this.compactionCheck.then(() =>
            this.lane
                .runWhenIdle(() => this.maybeCompact(), harnessContext)
                .catch((e: unknown) => {
                    // A closed lane (session detached mid-turn) is expected here.
                    log.debug("runWhenIdle for auto-compaction did not run:", e);
                }),
        );
        this.compactionCheck = next.catch(() => undefined);
    }

    /**
     * Auto-compaction entry. Reads effective compaction → estimates used
     * tokens → derives trigger-specific reserveTokens =
     * contextWindow*(1-threshold) → calls `harness.compact()` on hit.
     * Swallows failures (logs only).
     */
    private async maybeCompact(): Promise<void> {
        const { enabled, threshold } = this.effectiveCompaction();
        if (!enabled) return;
        let usedTokens: number;
        let contextWindow: number;
        try {
            const usage = await this.getContextUsage();
            usedTokens = usage.usedTokens;
            contextWindow = usage.model?.contextWindow ?? 0;
        } catch (e) {
            log.error("maybeCompact: failed to read context:", e);
            return;
        }
        if (!contextWindow || contextWindow <= 0) {
            log.error("maybeCompact: no usable model contextWindow");
            return;
        }

        // pi's shouldCompact formula: usedTokens > contextWindow - reserveTokens
        // Rearranged as a ratio: reserveTokens = ctxWindow * (1 - threshold)
        const reserveTokens = Math.max(0, Math.floor(contextWindow * (1 - threshold)));
        const willCompact = shouldCompact(usedTokens, contextWindow, {
            enabled: true,
            reserveTokens,
            keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
        });
        if (!willCompact) return;
        try {
            await this.runCompact();
        } catch (e) {
            // Busy / another run_end already triggered it — swallow and retry on next run_end.
            log.error("maybeCompact: harness.compact() failed:", e);
        }
    }

    /**
     * Manually trigger compaction and await the resulting `session_compact`
     * event. RPC `session.compact` calls this directly. `tokensBefore` /
     * `fromHook` come from that event, so they are only available on success.
     *
     * Bounded by `COMPACT_TIMEOUT_MS` (30s). `signal` aborting, the timeout
     * elapsing, and `harness.compact()` rejecting all resolve to
     * `{ ok: false, reason }` — `reason` distinguishes them so callers do not
     * have to parse logs.
     *
     * Cancellation is best-effort: pi's `harness.compact()` takes no
     * AbortSignal, so aborting only stops us waiting. An in-flight LLM summary
     * call runs to completion on the sidecar and may still append a compaction
     * entry to the session; we just no longer report it. Use `signal` to let
     * the UI escape a stuck "compacting" badge, not to halt the model call.
     */
    async compact(
        customInstructions?: string,
        signal?: AbortSignal,
    ): Promise<SessionCompactResult> {
        const COMPACT_TIMEOUT_MS = 30_000;
        let lastCompaction: { tokensBefore: number; fromHook: boolean } | undefined;
        const wait = waitForEvent({
            timeoutMs: COMPACT_TIMEOUT_MS,
            subscribe: (onEvent) =>
                this.harness.events.on("compaction_end", (event) => {
                    if (event.status !== "completed") return;
                    // `compaction_end` reports the entry id, not its contents.
                    // Read the entry for tokensBefore / fromHook, which the
                    // desktop shows in the compaction toast.
                    void this.readCompactionEntry(event.entryId).then((entry) => {
                        lastCompaction = entry;
                        onEvent();
                    });
                }),
        });
        const onAbort = (): void => wait.cancel();
        if (signal) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        }
        let harnessError: unknown;
        this.runCompact(customInstructions).catch((err: unknown) => {
            // Record before cancelling so the failure path can tell a harness
            // rejection apart from a timeout.
            harnessError = err;
            log.error("compact():", err);
            wait.cancel();
        });
        const received = await wait.promise;
        signal?.removeEventListener("abort", onAbort);
        // `received` only reports how the wait ended. A `compaction_end` that
        // landed in the same tick as a cancel still populated `lastCompaction`,
        // and the compaction it describes is committed to the session — report
        // it rather than throwing away a compaction that actually happened.
        if (!received && !lastCompaction) {
            const reason: NonNullable<SessionCompactResult["reason"]> = harnessError
                ? "harness_error"
                : signal?.aborted
                  ? "aborted"
                  : "timeout";
            if (reason === "timeout") {
                log.error("compact(): timed out after", COMPACT_TIMEOUT_MS, "ms");
            } else if (reason === "aborted") {
                log.error("compact(): aborted by caller");
            }
            return { ok: false, reason };
        }
        return {
            ok: true,
            tokensBefore: lastCompaction?.tokensBefore ?? 0,
            fromHook: lastCompaction?.fromHook ?? false,
        };
    }

    /**
     * Read a committed compaction entry's reportable fields.
     *
     * Never throws — a missing or mistyped entry degrades the toast's numbers,
     * which must not turn a successful compaction into a reported failure.
     */
    private async readCompactionEntry(
        entryId: string,
    ): Promise<{ tokensBefore: number; fromHook: boolean } | undefined> {
        try {
            const entry = await this.getEntry(entryId);
            if (entry?.type !== "compaction") return undefined;
            return { tokensBefore: entry.tokensBefore, fromHook: entry.fromHook };
        } catch (e) {
            log.debug("could not read compaction entry:", e);
            return undefined;
        }
    }
}
