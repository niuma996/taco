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
import {
    CompactionController,
    type CompactionLifecycleSignal,
} from "../../src/runtime/compaction/compactionController.ts";
import type { AgentLane, ExecutionToolContext } from "../../src/runtime/pi/types.ts";
import { type AgentHarness, LaneBusy, Result } from "../../src/runtime/pi/values.ts";
import { CompactionPushAdapter } from "../../src/server/compactionPushAdapter.ts";
import type { EmitPushFn } from "../../src/server/pushTypes.ts";

const CWD = "/tmp/ws";
const SESSION = "sess-1";

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
): { controller: CompactionController; emitRunEnd: () => void } {
    const forward = (signal: CompactionLifecycleSignal): void => {
        adapter.handleSessionEvent(
            CWD,
            SESSION,
            signal.phase === "start"
                ? { type: "taco_compaction_start", tokensBefore: signal.tokensBefore }
                : { type: "taco_compaction_end", reason: signal.reason },
        );
    };

    // Minimal event bus: the controller subscribes to run_end / compaction_end,
    // and the test needs to fire run_end to trigger a check.
    const listeners = new Map<string, Array<(event: unknown) => void>>();
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
    } as unknown as AgentHarness<ExecutionToolContext>;

    const lane = {
        // Always idle in these tests, so the deferred check runs immediately.
        runWhenIdle: async (callback: () => void | Promise<void>) => {
            await callback();
        },
        compact: async () => {
            await compactImpl();
            // Reaching here means compactImpl did not throw, so report the
            // committed-compaction shape the controller expects.
            return Result.ok({
                compaction: {
                    operationId: "op-1",
                    kind: "compaction" as const,
                    status: "completed" as const,
                    fromTipId: null,
                    tipId: "e1",
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
        // 900 used of a 1000-token window trips shouldCompact at threshold 0.7.
        getContextUsage: async () => ({ usedTokens: 900, model: { contextWindow: 1000 } }) as never,
        getSessionEntries: async () => [],
        getEntry: async () => undefined,
        readGlobalConfig: () => ({}) as never,
        onLifecycle: forward,
    });
    controller.subscribe();

    return {
        controller,
        emitRunEnd: () => {
            for (const listener of listeners.get("run_end") ?? []) listener({ type: "run_end" });
        },
    };
}

/**
 * Drive auto-compaction through the real public entry point — the `run_end`
 * event the controller subscribes to — and wait for the push frames to land.
 * `scheduleCompactionCheck` is fire-and-forget, so poll rather than await.
 */
async function runAutoCompact(
    emitRunEnd: () => void,
    frames: Array<{ method: string }>,
    expected: number,
): Promise<void> {
    emitRunEnd();
    for (let i = 0; i < 200 && frames.length < expected; i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe("compaction lifecycle interlock", () => {
    it("engages the interlock while compaction runs", async () => {
        const { adapter, frames } = newAdapter();
        let seenDuringCompact: boolean | undefined;
        const { emitRunEnd } = newController(adapter, async () => {
            // Observed mid-flight: the interlock must be engaged here, which is
            // what makes awaitCompactionEnd actually wait and the desktop freeze.
            seenDuringCompact = adapter.isCompressing(CWD, SESSION);
        });

        await runAutoCompact(emitRunEnd, frames, 2);

        assert.equal(seenDuringCompact, true, "inflight must be set during compact()");
        assert.equal(frames[0]?.method, "session.compaction_started");
    });

    it("releases the interlock when compaction throws", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd } = newController(adapter, async () => {
            throw new Error("summary failed");
        });

        await runAutoCompact(emitRunEnd, frames, 2);

        // The whole point: no `session_compact` is emitted on this path, so
        // without the `finally` unwind the record would latch forever and every
        // later prompt would burn the full awaitCompactionEnd timeout.
        assert.equal(adapter.isCompressing(CWD, SESSION), false);
        assert.equal(await adapter.awaitCompactionEnd(CWD, SESSION, 50), true);
    });

    it("still emits a finished frame when compaction never commits", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd } = newController(adapter, async () => {
            throw new Error("cancelled by hook");
        });

        await runAutoCompact(emitRunEnd, frames, 2);

        assert.deepEqual(
            frames.map((f) => f.method),
            ["session.compaction_started", "session.compaction_finished"],
            "desktop must receive a finished frame so the input freeze lifts",
        );
    });

    it("classifies failure reason on the finished frame when compaction throws", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd } = newController(adapter, async () => {
            throw new Error("summary failed");
        });

        await runAutoCompact(emitRunEnd, frames, 2);

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
        const { emitRunEnd } = newController(adapter, async () => {
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

        await runAutoCompact(emitRunEnd, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "busy");
    });

    it("classifies 'cancelled' reason when a hook cancels compaction", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd } = newController(adapter, async () => {
            throw new Error("compaction cancelled by hook");
        });

        await runAutoCompact(emitRunEnd, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "cancelled");
    });

    it("classifies 'nothing' reason when the lane reports nothing to compact", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd } = newController(adapter, async () => {
            throw new Error("Nothing to compact");
        });

        await runAutoCompact(emitRunEnd, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string; failureMessage?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "nothing");
        assert.equal(finished?.failureMessage, undefined);
    });

    it("does not include a reason on the successful finished frame", async () => {
        const { adapter, frames } = newAdapter();
        const { emitRunEnd } = newController(adapter, async () => {
            adapter.handleSessionEvent(CWD, SESSION, {
                type: "session_compact",
                compactionEntry: { summary: "ok", fromHook: true },
            });
        });

        await runAutoCompact(emitRunEnd, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, false);
        assert.equal(finished?.reason, undefined);
    });
});
