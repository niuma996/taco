/** CompactionController — auto-compaction scheduling + manual compaction entry point. */

import { performance } from "node:perf_hooks";
import {
    type AgentHarness,
    AgentHarnessError,
    type AgentHarnessEvent,
    DEFAULT_COMPACTION_SETTINGS,
    type ExecutionToolContext,
    type SessionTreeEntry,
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
import { createLogger } from "../lib/logger.ts";
import type { ContextUsage } from "./contextInfoService.ts";
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
 * Why this exists rather than reusing pi's `session_before_compact`: that event
 * is dispatched through `emitHook`, which only reaches type-specific
 * `harness.on(...)` handlers — never `harness.subscribe(...)`, which is the
 * channel that feeds `session.event`. Its counterpart `session_compact` goes
 * through `emitOwn` and *does* reach subscribers, so keying an interlock on the
 * pi events alone yields an end without a start, and no start at all for the
 * push layer. The `finally` that emits `end` is the pairing guarantee.
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
 * Map a `harness.compact()` throw onto the wire-visible failure reason.
 *
 * pi signals both "not idle" and "a hook cancelled" through `AgentHarnessError`,
 * distinguished only by `code` — `busy` and `compaction` respectively. Anything
 * unrecognised is reported as `harness_error` rather than guessed at.
 *
 * pi 0.83 throws English message strings only; bump these matchers if pi's text
 * changes.
 */
function classifyCompactFailure(e: unknown): CompactionFailureReason {
    if (e instanceof AgentHarnessError) {
        if (e.code === "busy") return "busy";
        // pi throws code "compaction" for a cancelling hook, "nothing to compact",
        // and possibly other compaction-phase skips. The message is the only
        // discriminator, so we sniff for the two cases worth surfacing distinctly.
        if (e.code === "compaction" && /cancel/i.test(e.message)) return "cancelled";
        if (e.code === "compaction" && /nothing/i.test(e.message)) return "nothing";
    }
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
    harness: AgentHarness<ExecutionToolContext>;
    /** Injected compaction policy (undefined falls back to enabled=true/threshold=0.7). */
    compaction?: ResolvedCompaction;
    /** Shared context-usage read path — supplied by ContextInfoService to avoid duplicated buildContext. */
    getContextUsage: () => Promise<ContextUsage>;
    /** PinOnceConsumer — updates its consumed set when a compaction completes. */
    pinOnceConsumer?: PinOnceConsumer;
    /** Get current session's branch entries — used to update PinOnceConsumer. */
    getSessionEntries: () => Promise<SessionTreeEntry[]>;
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
 * `maybeCompact()` on every `settled` and by `getCompactionThreshold` on every
 * context build / `session_before_compact`. 1s covers 99% of "user changed
 * the threshold and immediately starts the next turn" scenarios; explicit
 * `invalidate()` (triggered by `settings.write`) makes user edits visible
 * nanoseconds after the write.
 */
const EFFECTIVE_TTL_MS = 1_000;

export class CompactionController {
    private readonly harness: AgentHarness<ExecutionToolContext>;
    private readonly compaction: ResolvedCompaction | undefined;
    private readonly getContextUsage: () => Promise<ContextUsage>;
    private readonly pinOnceConsumer?: PinOnceConsumer;
    private readonly getSessionEntries: () => Promise<SessionTreeEntry[]>;
    private readonly readGlobalConfig: ReadGlobalConfig;
    private readonly effectiveTtlMs: number;
    private readonly now: Now;
    private readonly onLifecycle?: (signal: CompactionLifecycleSignal) => void;
    /**
     * Serialized auto-compaction-check promise. Each `settled` event chains onto
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
        this.compaction = opts.compaction;
        this.getContextUsage = opts.getContextUsage;
        this.pinOnceConsumer = opts.pinOnceConsumer;
        this.getSessionEntries = opts.getSessionEntries;
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
            await this.harness.compact(customInstructions);
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
     * Invoked from AttachedSession's harness event callback. Handles:
     *  - `settled` (nextTurnCount===0): queue an auto-compaction check
     *  - `session_compact`: update PinOnceConsumer
     */
    onHarnessEvent(event: AgentHarnessEvent): void {
        // Auto-compaction trigger point: harness has set phase=idle and cleared
        // pending writes after `agent_end` before emitting `settled`. Only check
        // when nextTurnCount===0 — steer / follow-up queued turns must not race
        // the compaction decision.
        if (event.type === "settled" && event.nextTurnCount === 0) {
            this.scheduleCompactionCheck();
            return;
        }
        if (event.type === "session_compact") {
            // Update PinOnceConsumer consumed set so context hooks skip re-injection.
            if (this.pinOnceConsumer) {
                const consumer = this.pinOnceConsumer;
                const getEntries = this.getSessionEntries;
                getEntries()
                    .then((entries) => {
                        consumer.mergeConsumed(entries);
                    })
                    .catch(() => undefined);
            }
        }
    }

    /**
     * Serialized auto-compaction check. Multiple `settled` events queue in
     * order; one `harness.compact()` throw does not interrupt later checks.
     * Internal fire-and-forget — does not block `prompt()`.
     */
    private scheduleCompactionCheck(): void {
        const next = this.compactionCheck.then(() => this.maybeCompact());
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
            // Busy / another settled already triggered it — swallow and retry on next settled.
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
        let lastCompactEvent: Extract<AgentHarnessEvent, { type: "session_compact" }> | undefined;
        const wait = waitForEvent({
            timeoutMs: COMPACT_TIMEOUT_MS,
            subscribe: (onEvent) => {
                const unsub = this.harness.subscribe((event) => {
                    if (event.type === "session_compact") {
                        lastCompactEvent = event;
                        onEvent();
                    }
                });
                return unsub;
            },
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
        // `received` only reports how the wait ended. A `session_compact` that
        // landed in the same tick as a cancel still populated `lastCompactEvent`,
        // and the compaction it describes is committed to the session — report
        // it rather than throwing away a compaction that actually happened.
        if (!received && !lastCompactEvent) {
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
            tokensBefore: lastCompactEvent?.compactionEntry.tokensBefore ?? 0,
            fromHook: lastCompactEvent?.compactionEntry.fromHook ?? false,
        };
    }
}
