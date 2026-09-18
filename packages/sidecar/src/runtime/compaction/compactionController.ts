/** CompactionController — auto-compaction scheduling + manual compaction entry point. */

import { performance } from "node:perf_hooks";
import type { CompactionFailureReason, SessionCompactResult } from "@taco-ai/protocol";
import { DEFAULT_COMPACTION_ENABLED, DEFAULT_COMPACTION_THRESHOLD } from "@taco-ai/protocol";
import {
    type ResolvedCompaction,
    readGlobalConfig,
    validateCompactionConfig,
} from "../../config/config.ts";
import { waitForEvent } from "../../lib/async.ts";
import { contextFor, harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import { isBusyError, toHarnessError } from "../harness/harnessErrors.ts";
import type { AgentLane, Entry, ExecutionToolContext } from "../pi/types.ts";
import type { AgentHarness } from "../pi/values.ts";
import { CompactionError, NothingToCompact } from "../pi/values.ts";
import { deriveCompactionSettings, triggerTokens } from "./compactionSettings.ts";
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
 * pi 0.85 does emit `compaction_start` and `compaction_end` on the same event
 * bus, but the sidecar's own pair is kept because pi's events do not cover the
 * paths this interlock has to survive:
 *
 *   1. `LaneBusy` / `NothingToCompact` are returned from admission, before any
 *      drive runs — pi emits nothing at all, yet the push layer must still see
 *      a `start`/`end` pair or the desktop input freeze latches.
 *   2. `compaction_end` carries only `entryId`, not the figures the toast wants.
 *
 * Success is reported through `committed`, NOT through a `session_compact`
 * event: pi 0.85 has no such event, so a consumer waiting for one sees every
 * compaction as a failure.
 */
export type CompactionLifecycleSignal =
    | { phase: "start"; tokensBefore: number }
    | {
          phase: "end";
          /**
           * Set when `harness.compact()` threw, or when the operation settled
           * without a readable committed entry (hook decline, abort, or
           * completed-but-unreadable). An unset `reason` with an unset
           * `committed` means the classification pipeline itself did not run.
           */
          reason?: CompactionFailureReason;
          /** Present only when a compaction entry was committed. */
          committed?: { summaryChars: number; fromHook: boolean };
      };

/**
 * Map a compaction failure onto the wire-visible failure reason.
 *
 * pi 0.85 splits failures across two error families, and each is read through
 * its own structured discriminant rather than its message:
 *
 *   - Tagged errors (`LaneBusy`, `NothingToCompact`) carry `_tag`.
 *     `toHarnessError` copies `_tag` onto its wrapper but not the prototype,
 *     so the tag is checked as a string as well as via the `.is()` guard.
 *   - `CompactionError` carries a structured `code` and no `_tag`.
 *
 * A `before_compaction` hook returning `{decline: true}` is not an error in
 * 0.85 — `compact()` succeeds with `declined` status, handled at the call site.
 * The `cancelled` reason survives here for pre-0.85 sessions and test doubles
 * that still surface a cancelling hook as a rejection.
 */
function classifyCompactFailure(e: unknown): CompactionFailureReason {
    if (isBusyError(e)) return "busy";
    if (NothingToCompact.is(e)) return "nothing";
    const tag = (e as { _tag?: unknown } | null)?._tag;
    if (tag === "NothingToCompact") return "nothing";
    // Read `code` before falling back to the message so a reworded pi message
    // cannot silently reclassify a cancellation as a harness failure. The name
    // check covers a duplicate pi copy for which `instanceof` would be false.
    if (
        e instanceof CompactionError ||
        (e as { name?: unknown } | null)?.name === "CompactionError"
    ) {
        return (e as { code?: unknown }).code === "aborted" ? "aborted" : "harness_error";
    }
    // Message sniffing stays as the backstop for test doubles and non-pi
    // rejections (e.g. a raw AbortError from a wrapper), which carry no code.
    const message = e instanceof Error ? e.message : String(e);
    if (/nothing to compact/i.test(message)) return "nothing";
    if (/abort/i.test(message)) return "aborted";
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
     *
     * Returns the classified outcome instead of throwing, so the caller that
     * needs the reason (the `session.compact` RPC) reports the same
     * classification the lifecycle sink just published, rather than
     * re-deriving — and flattening — it.
     *
     * `signal`, when supplied, is threaded into pi's Context so the summary
     * LLM call itself aborts with the caller (pi passes `context.abortSignal`
     * to the provider request); pi then finishes the compaction with status
     * "aborted" or a thrown `CompactionError`.
     */
    private async runCompact(
        customInstructions?: string,
        signal?: AbortSignal,
    ): Promise<{ ok: true } | { ok: false; reason: CompactionFailureReason; error: unknown }> {
        const tokensBefore = await this.readTokensBefore();
        try {
            this.onLifecycle?.({ phase: "start", tokensBefore });
        } catch (e) {
            log.error("compaction lifecycle start sink threw:", e);
        }
        let reason: CompactionFailureReason | undefined;
        let committed: { summaryChars: number; fromHook: boolean } | undefined;
        let error: unknown;
        try {
            const result = await this.lane.compact(
                customInstructions === undefined ? undefined : { customInstructions },
                signal ? contextFor(signal) : harnessContext,
            );
            if (!result.ok) throw toHarnessError("compact", result.error);
            const record = result.value.compaction;
            if (record.status === "completed") {
                // The record's `tipId` is the committed compaction entry (pi sets
                // it from the operation's resultEntryId on success). Read it here
                // because the end signal is the only channel carrying the toast
                // figures — pi 0.85 has no `session_compact` event to read them from.
                const entry = await this.readCompactionEntry(record.tipId);
                if (entry === undefined) {
                    // Completed but unverifiable (null tipId, disk miss, GC).
                    // Must not return ok: the toast already treats a missing
                    // committed summary as failure, and the RPC has to match.
                    reason = "harness_error";
                } else {
                    committed = { summaryChars: entry.summaryChars, fromHook: entry.fromHook };
                }
            } else {
                // `declined` means a `before_compaction` hook refused; `aborted`
                // and `failed` speak for themselves. None of them throw in 0.85,
                // so the reason has to be derived from the operation record.
                reason =
                    record.status === "declined"
                        ? "cancelled"
                        : record.status === "aborted"
                          ? "aborted"
                          : "harness_error";
            }
        } catch (e) {
            reason = classifyCompactFailure(e);
            error = e;
        } finally {
            try {
                this.onLifecycle?.({
                    phase: "end",
                    ...(reason ? { reason } : {}),
                    ...(committed ? { committed } : {}),
                });
            } catch (e) {
                log.error("compaction lifecycle end sink threw:", e);
            }
        }
        return reason === undefined ? { ok: true } : { ok: false, reason, error };
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
     * next `effectiveCompaction()` call (no waiting for TTL). The derived
     * settings are re-pushed as a side effect — without that, pi's own
     * turn-boundary check would keep firing on the previous threshold.
     *
     * Fire-and-forget: the settings fanout that calls this is synchronous, and
     * `maybeCompact` reads the fresh threshold through `effectiveCompaction()`
     * regardless of whether the push has landed yet.
     */
    invalidate(): void {
        this.cachedEffective = undefined;
        void this.syncSettings();
    }

    /**
     * Push the derived settings onto pi, so all three compaction paths (pi's
     * turn-boundary overflow check, `maybeCompact`, and the pin-aware hook)
     * read one instance instead of three disagreeing ones.
     *
     * Re-derived on every call rather than cached: the inputs are a config
     * field and the lane's model window, both of which change without this
     * controller being reconstructed (pi 0.85 keeps model selection per-lane).
     *
     * Guarded by comparison — `setCompactionSettings` emits a `config_update`
     * event, so an unconditional write would broadcast on every attach and
     * every settings write whether or not anything actually moved.
     */
    async syncSettings(): Promise<void> {
        const { enabled, threshold } = this.effectiveCompaction();
        let contextWindow = 0;
        try {
            contextWindow = (await this.lane.getModel(harnessContext))?.contextWindow ?? 0;
        } catch (e) {
            log.error("syncSettings: could not read the model window:", e);
            return;
        }
        const next = deriveCompactionSettings(enabled, threshold, contextWindow);
        try {
            const current = await this.harness.getCompactionSettings(harnessContext);
            if (
                current.enabled === next.enabled &&
                current.reserveTokens === next.reserveTokens &&
                current.keepRecentTokens === next.keepRecentTokens
            ) {
                return;
            }
            await this.harness.setCompactionSettings(next, harnessContext);
        } catch (e) {
            log.error("syncSettings: could not apply compaction settings:", e);
        }
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
     * tokens → calls `harness.compact()` once usage crosses the user's
     * threshold. Swallows failures (logs only).
     *
     * Retention (`keepRecentTokens`) is not decided here — it lives in the
     * shared settings `syncSettings()` pushes, which is what keeps this path
     * and pi's turn-boundary check cutting at the same place.
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

        // The user's threshold is the trigger, compared directly rather than
        // through `shouldCompact`: `reserveTokens` carries the summary output
        // budget (see compactionSettings.ts), so borrowing it to express the
        // trigger would re-couple the two budgets this module just split.
        if (usedTokens <= triggerTokens(contextWindow, threshold)) return;
        // Busy / another run_end already triggered it — log and retry on the
        // next run_end. `runCompact` reports rather than throws.
        const outcome = await this.runCompact();
        if (!outcome.ok) {
            log.error("maybeCompact: harness.compact() failed:", outcome.reason, outcome.error);
        }
    }

    /**
     * Manually trigger compaction and await pi's `compaction_end` event. RPC
     * `session.compact` calls this directly. `tokensBefore` / `fromHook` are
     * read off the committed entry named by that event, so they are only
     * available on success.
     *
     * Bounded by `COMPACT_TIMEOUT_MS` (30s). `signal` aborting, the timeout
     * elapsing, and a classified harness rejection all resolve to
     * `{ ok: false, reason }` — `reason` distinguishes them so callers do not
     * have to parse logs.
     *
     * Cancellation: the caller's signal is threaded into pi's Context
     * (`contextFor`), so aborting cancels the in-flight summary LLM call —
     * pi hands `context.abortSignal` to the provider request. A cancelled
     * summary surfaces as status "aborted" or a thrown `CompactionError`;
     * the wait resolves `{ ok: false, reason: "aborted" }` either way, and no
     * compaction entry is committed for the aborted attempt.
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
                        // Missing entry is not success — leave the wait pending
                        // so `runCompact`'s classified `harness_error` is what
                        // the RPC reports, matching the toast.
                        if (entry === undefined) return;
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
        let failure: { reason: CompactionFailureReason; error: unknown } | undefined;
        this.runCompact(customInstructions, signal)
            .then((outcome) => {
                if (outcome.ok) return;
                // Record before cancelling so the failure path can tell a
                // classified rejection apart from a timeout.
                failure = outcome;
                log.error("compact():", outcome.reason, outcome.error);
                wait.cancel();
            })
            .catch((err: unknown) => {
                // Defensive: runCompact reports instead of throwing, but this
                // is fire-and-forget and must not surface as an unhandled
                // rejection if that ever changes.
                failure = { reason: classifyCompactFailure(err), error: err };
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
            const reason: NonNullable<SessionCompactResult["reason"]> = failure
                ? failure.reason
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
     * Read a committed compaction entry's reportable figures.
     *
     * Never throws — a missing or mistyped entry returns undefined so the
     * caller can classify it. `runCompact` treats that as `harness_error`
     * rather than reporting success without a summary for the toast.
     * Accepts a null id so callers can pass an operation record's `tipId`
     * without a separate guard.
     */
    private async readCompactionEntry(
        entryId: string | null,
    ): Promise<{ tokensBefore: number; summaryChars: number; fromHook: boolean } | undefined> {
        if (entryId === null) return undefined;
        try {
            const entry = await this.getEntry(entryId);
            if (entry?.type !== "compaction") return undefined;
            return {
                tokensBefore: entry.tokensBefore,
                summaryChars: entry.summary.length,
                fromHook: entry.fromHook,
            };
        } catch (e) {
            log.debug("could not read compaction entry:", e);
            return undefined;
        }
    }
}
