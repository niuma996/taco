/**
 * Compaction lifecycle interlock — CompactionController → CompactionPushAdapter.
 *
 * Regression coverage for the gap that let the interlock rot silently: the
 * adapter's own unit tests feed the compaction event straight into
 * `handleSessionEvent`, so they passed while nothing in production ever
 * delivered it. pi dispatches `before_compaction` to hook handlers only, which
 * never reaches the event bus that feeds `session.event`.
 *
 * These tests drive the real controller and assert on what the adapter
 * observes, so a future regression in either half — or an upstream change to
 * pi's dispatch channels — fails here.
 *
 * The controller reacts to `run_end` and defers the check through
 * `lane.runWhenIdle`, so the stubs below have to honour both.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import {
    CompactionController,
    type CompactionLifecycleSignal,
} from "../../src/runtime/compaction/compactionController.ts";
import type {
    AgentLane,
    CompactionSettings,
    ExecutionToolContext,
} from "../../src/runtime/pi/types.ts";
import {
    type AgentHarness,
    CompactionError,
    LaneBusy,
    NothingToCompact,
    Result,
} from "../../src/runtime/pi/values.ts";
import { CompactionPushAdapter } from "../../src/server/compactionPushAdapter.ts";
import type { EmitPushFn } from "../../src/server/pushTypes.ts";

const CWD = asWorkspaceId("/tmp/ws");
const SESSION = asSessionId("sess-1");

/** Entry id the lane stub reports as the committed compaction; `getEntry` serves it. */
const COMPACTED_ENTRY_ID = "e1";
/** Summary length the committed entry carries, asserted on the finished frame. */
const COMPACTED_SUMMARY_CHARS = 1234;

/** Records every push frame the adapter emits, in order. */
function newAdapter(): {
    adapter: CompactionPushAdapter;
    frames: Array<{ method: string; params?: unknown }>;
} {
    const frames: Array<{ method: string; params?: unknown }> = [];
    const emit: EmitPushFn = (method, _cwd, _sid, params) => {
        frames.push({ method: String(method), params });
    };
    return { adapter: new CompactionPushAdapter(emit), frames };
}

/**
 * Controller wired to a harness stub whose `compact()` behaviour is scripted,
 * with the lifecycle sink pointed at a real adapter (mirroring how
 * AttachedSession forwards the signal onto the `session.event` stream).
 */
function newController(
    adapter: CompactionPushAdapter,
    compactImpl: () => Promise<unknown>,
    /**
     * When set, `lane.compact` answers with `Result.err(rejectWith)` instead of
     * a committed compaction — the shape `acceptCompaction` uses for admission
     * failures (`LaneBusy` / `NothingToCompact` / `Closed`).
     */
    rejectWith?: unknown,
    /**
     * Override the committed entry id the lane reports. A value `getEntry`
     * does not serve (including `null`) is the completed-but-unreadable path.
     */
    tipId: string | null = COMPACTED_ENTRY_ID,
): {
    controller: CompactionController;
    pushed: CompactionSettings[];
    emitRunEnd: () => void;
    compactionEnded: Promise<void>;
} {
    let settleEnd: (() => void) | undefined;
    const compactionEnded = new Promise<void>((resolve) => {
        settleEnd = resolve;
    });
    const forward = (signal: CompactionLifecycleSignal): void => {
        adapter.handleSessionEvent(
            CWD,
            SESSION,
            signal.phase === "start"
                ? { type: "taco_compaction_start", tokensBefore: signal.tokensBefore }
                : {
                      type: "taco_compaction_end",
                      reason: signal.reason,
                      committed: signal.committed,
                  },
        );
        if (signal.phase === "end") settleEnd?.();
    };

    // Minimal event bus: the controller subscribes to run_end / compaction_end,
    // and the test needs to fire run_end to trigger a check. The settings pair
    // is what `syncSettings()` pushes through — recorded so tests can assert
    // the derived values without reaching into the controller.
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const pushed: CompactionSettings[] = [];
    let settings: CompactionSettings = {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
    };
    const harness = {
        events: {
            on(type: string, listener: (event: unknown) => void) {
                const set = listeners.get(type) ?? [];
                set.push(listener);
                listeners.set(type, set);
                return () => {
                    listeners.set(
                        type,
                        (listeners.get(type) ?? []).filter((l) => l !== listener),
                    );
                };
            },
        },
        getCompactionSettings: async () => settings,
        setCompactionSettings: async (next: CompactionSettings) => {
            settings = next;
            pushed.push(next);
        },
    } as unknown as AgentHarness<ExecutionToolContext>;

    const lane = {
        // Always idle in these tests, so the deferred check runs immediately.
        runWhenIdle: async (callback: () => void | Promise<void>) => {
            await callback();
        },
        getModel: async () => ({ contextWindow: 1000 }),
        compact: async () => {
            await compactImpl();
            if (rejectWith !== undefined) return Result.err(rejectWith);
            // Reaching here means compactImpl did not throw, so report the
            // committed-compaction shape the controller expects. `tipId` is the
            // committed entry — the controller reads it back for the toast
            // figures the end signal has to carry.
            return Result.ok({
                compaction: {
                    operationId: "op-1",
                    kind: "compaction" as const,
                    status: "completed" as const,
                    fromTipId: null,
                    tipId,
                    startedAt: 0,
                    endedAt: 1,
                },
            });
        },
    } as unknown as AgentLane;

    const controller = new CompactionController({
        harness,
        lane,
        compaction: { enabled: true, threshold: 0.7 },
        // 900 used of a 1000-token window, so the 0.7 threshold trips at 700.
        getContextUsage: async () => ({ usedTokens: 900, model: { contextWindow: 1000 } }) as never,
        getSessionEntries: async () => [],
        getEntry: async (id: string) =>
            id === COMPACTED_ENTRY_ID
                ? ({
                      type: "compaction",
                      summary: "s".repeat(COMPACTED_SUMMARY_CHARS),
                      tokensBefore: 100,
                      fromHook: true,
                      retainedTail: [],
                  } as never)
                : undefined,
        readGlobalConfig: () => ({}) as never,
        onLifecycle: forward,
    });
    controller.subscribe();

    return {
        controller,
        pushed,
        compactionEnded,
        emitRunEnd: () => {
            for (const listener of listeners.get("run_end") ?? []) listener({ type: "run_end" });
        },
    };
}

/**
 * Drive auto-compaction through the real public entry point — the `run_end`
 * event the controller subscribes to — and wait for the lifecycle `end`
 * signal rather than polling for push frames.
 */
async function runAutoCompact(
    emitRunEnd: () => void,
    compactionEnded: Promise<void>,
): Promise<void> {
    emitRunEnd();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            compactionEnded,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("compaction end signal never arrived")),
                    5_000,
                );
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

describe("compaction lifecycle interlock", () => {
    it("engages the interlock while compaction runs", async () => {
        const { adapter, frames } = newAdapter();
        let seenDuringCompact: boolean | undefined;
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {
            // Observed mid-flight: the interlock must be engaged here, which is
            // what makes awaitCompactionEnd actually wait and the desktop freeze.
            seenDuringCompact = adapter.isCompressing(CWD, SESSION);
        });

        await runAutoCompact(emitRunEnd, compactionEnded);

        assert.equal(seenDuringCompact, true, "inflight must be set during compact()");
        assert.equal(frames[0]?.method, "session.compaction_started");
    });

    it("releases the interlock when compaction throws", async () => {
        const { adapter } = newAdapter();
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {
            throw new Error("summary failed");
        });

        await runAutoCompact(emitRunEnd, compactionEnded);

        // The whole point: no `session_compact` is emitted on this path, so
        // without the `finally` unwind the record would latch forever and every
        // later prompt would burn the full awaitCompactionEnd timeout.
        assert.equal(adapter.isCompressing(CWD, SESSION), false);
        assert.equal(await adapter.awaitCompactionEnd(CWD, SESSION, 50), true);
    });

    it("still emits a finished frame when compaction never commits", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {
            throw new Error("cancelled by hook");
        });

        await runAutoCompact(emitRunEnd, compactionEnded);

        assert.deepEqual(
            frames.map((f) => f.method),
            ["session.compaction_started", "session.compaction_finished"],
            "desktop must receive a finished frame so the input freeze lifts",
        );
    });

    it("classifies failure reason on the finished frame when compaction throws", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {
            throw new Error("summary failed");
        });

        await runAutoCompact(emitRunEnd, compactionEnded);

        assert.equal(adapter.isCompressing(CWD, SESSION), false);
        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string; failureMessage?: string }
            | undefined;
        assert.ok(finished, "finished frame must be emitted");
        assert.equal(finished.failed, true);
        assert.equal(finished.reason, "harness_error");
        assert.equal(finished.failureMessage, undefined);
    });

    it("classifies 'busy' reason when the lane is already running an operation", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {
            // pi 0.85 signals this as a tagged LaneBusy rather than a coded
            // AgentHarnessError. Note it is NOT a HarnessFault subclass, so
            // classification has to match on the tag.
            throw new LaneBusy({
                lane: "main",
                operationId: "op-0",
                operationKind: "run",
                message: "lane is busy",
            });
        });

        await runAutoCompact(emitRunEnd, compactionEnded);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "busy");
    });

    it("classifies 'cancelled' reason when a hook cancels compaction", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {
            throw new Error("compaction cancelled by hook");
        });

        await runAutoCompact(emitRunEnd, compactionEnded);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "cancelled");
    });

    it("classifies 'nothing' reason when the lane reports nothing to compact", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {
            throw new Error("Nothing to compact");
        });

        await runAutoCompact(emitRunEnd, compactionEnded);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string; failureMessage?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "nothing");
        assert.equal(finished?.failureMessage, undefined);
    });

    it("reports the committed summary on the successful finished frame", async () => {
        // End-to-end regression for the success signal: the controller has to
        // learn about the committed entry itself, because pi 0.85 emits no
        // `session_compact` event for the adapter to key off. Before this was
        // wired, every successful compaction reached the desktop as a failure.
        const { adapter, frames } = newAdapter();
        const { emitRunEnd, compactionEnded } = newController(adapter, async () => {});

        await runAutoCompact(emitRunEnd, compactionEnded);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | {
                  failed?: boolean;
                  reason?: string;
                  failureMessage?: string;
                  summaryChars?: number;
                  fromHook?: boolean;
              }
            | undefined;
        assert.ok(finished, "finished frame must be emitted");
        assert.equal(finished.failed, false);
        assert.equal(finished.reason, undefined);
        assert.equal(finished.failureMessage, undefined);
        assert.equal(finished.summaryChars, COMPACTED_SUMMARY_CHARS);
        assert.equal(finished.fromHook, true);
    });

    it("classifies completed-but-unreadable as harness_error, matching the toast", async () => {
        // Regression: pi reporting status=completed with a tipId that
        // getEntry cannot serve used to return {ok:true} from runCompact
        // while the lifecycle end had no committed — RPC said success,
        // desktop toasted "compaction did not commit a summary".
        const { adapter, frames } = newAdapter();
        const { emitRunEnd, compactionEnded, controller } = newController(
            adapter,
            async () => {},
            undefined,
            "missing-entry",
        );

        await runAutoCompact(emitRunEnd, compactionEnded);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string; failureMessage?: string }
            | undefined;
        assert.ok(finished, "finished frame must be emitted");
        assert.equal(finished.failed, true);
        assert.equal(finished.reason, "harness_error");
        assert.equal(finished.failureMessage, undefined);

        const rpc = await controller.compact();
        assert.equal(rpc.ok, false);
        assert.equal(rpc.reason, "harness_error");
    });
});

describe("CompactionController.syncSettings", () => {
    it("pushes threshold-derived settings onto the harness", async () => {
        const { adapter } = newAdapter();
        const { controller, pushed } = newController(adapter, async () => {});

        await controller.syncSettings();

        assert.equal(pushed.length, 1);
        // A 1000-token window at threshold 0.7: the trigger is 700, and both
        // derived budgets fall to their floors because the window is tiny
        // (reserve's 4096 floor, keep's ceiling of 0.8 x trigger = 560).
        assert.deepEqual(pushed[0], {
            enabled: true,
            reserveTokens: 4096,
            keepRecentTokens: 560,
        });
    });

    it("skips the write when the derived settings are unchanged", async () => {
        const { adapter } = newAdapter();
        const { controller, pushed } = newController(adapter, async () => {});

        await controller.syncSettings();
        await controller.syncSettings();

        // `setCompactionSettings` emits a config_update event, so an
        // unconditional write would broadcast on every attach regardless of
        // whether anything actually moved.
        assert.equal(pushed.length, 1);
    });

    it("re-derives after invalidate() but still absorbs an unchanged value", async () => {
        const { adapter } = newAdapter();
        const { controller, pushed } = newController(adapter, async () => {});

        await controller.syncSettings();
        controller.invalidate();
        // invalidate() is fire-and-forget — let the settings push settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(pushed.length, 1, "the comparison guard must absorb the re-push");
    });
});

describe("session.compact failure classification", () => {
    it("reports `nothing` for a tagged NothingToCompact", async () => {
        const { adapter } = newAdapter();
        const { controller } = newController(
            adapter,
            async () => {},
            new NothingToCompact({ lane: "main", message: "lane has nothing to compact" }),
        );

        const result = await controller.compact();

        assert.equal(result.ok, false);
        assert.equal(result.reason, "nothing");
    });

    it("reads CompactionError.code instead of its message", async () => {
        const { adapter } = newAdapter();
        const { controller } = newController(adapter, async () => {
            // Deliberately worded so the message-sniffing backstop would
            // disagree: the structured code is the only correct signal.
            throw new CompactionError("aborted", "the request was stopped");
        });

        const result = await controller.compact();

        assert.equal(result.ok, false);
        assert.equal(result.reason, "aborted");
    });

    it("still classifies a bare Error through its message", async () => {
        const { adapter } = newAdapter();
        const { controller } = newController(adapter, async () => {
            throw new Error("Nothing to compact");
        });

        const result = await controller.compact();

        assert.equal(result.ok, false);
        assert.equal(result.reason, "nothing");
    });
});
