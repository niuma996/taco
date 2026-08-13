/**
 * Compaction lifecycle interlock — CompactionController → CompactionPushAdapter.
 *
 * Regression coverage for the gap that let the interlock rot silently: the
 * adapter's own unit tests feed `session_before_compact` straight into
 * `handleSessionEvent`, so they passed while nothing in production ever
 * delivered that event. pi dispatches it via `emitHook` (type-specific
 * handlers only), which never reaches the `harness.subscribe` stream that
 * feeds `session.event`.
 *
 * These tests drive the real controller and assert on what the adapter
 * observes, so a future regression in either half — or an upstream change to
 * pi's dispatch channels — fails here.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    type AgentHarness,
    AgentHarnessError,
    type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import {
    CompactionController,
    type CompactionLifecycleSignal,
} from "../../src/runtime/compactionController.ts";
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
): CompactionController {
    const forward = (signal: CompactionLifecycleSignal): void => {
        adapter.handleSessionEvent(
            CWD,
            SESSION,
            signal.phase === "start"
                ? { type: "taco_compaction_start", tokensBefore: signal.tokensBefore }
                : { type: "taco_compaction_end", reason: signal.reason },
        );
    };
    const harness = { compact: compactImpl } as unknown as AgentHarness<ExecutionToolContext>;
    return new CompactionController({
        harness,
        compaction: { enabled: true, threshold: 0.7 },
        // 900 used of a 1000-token window trips shouldCompact at threshold 0.7.
        getContextUsage: async () => ({ usedTokens: 900, model: { contextWindow: 1000 } }) as never,
        getSessionEntries: async () => [],
        readGlobalConfig: () => ({}) as never,
        onLifecycle: forward,
    });
}

/**
 * Drive auto-compaction through the real public entry point — the `settled`
 * event AttachedSession forwards — and wait for the push frames to land.
 * `scheduleCompactionCheck` is fire-and-forget, so poll rather than await.
 */
async function runAutoCompact(
    controller: CompactionController,
    frames: Array<{ method: string }>,
    expected: number,
): Promise<void> {
    controller.onHarnessEvent({ type: "settled", nextTurnCount: 0 } as never);
    for (let i = 0; i < 200 && frames.length < expected; i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe("compaction lifecycle interlock", () => {
    it("engages the interlock while compaction runs", async () => {
        const { adapter, frames } = newAdapter();
        let seenDuringCompact: boolean | undefined;
        const controller = newController(adapter, async () => {
            // Observed mid-flight: the interlock must be engaged here, which is
            // what makes awaitCompactionEnd actually wait and the desktop freeze.
            seenDuringCompact = adapter.isCompressing(CWD, SESSION);
        });

        await runAutoCompact(controller, frames, 2);

        assert.equal(seenDuringCompact, true, "inflight must be set during compact()");
        assert.equal(frames[0]?.method, "session.compaction_started");
    });

    it("releases the interlock when compaction throws", async () => {
        const { adapter, frames } = newAdapter();
        const controller = newController(adapter, async () => {
            throw new Error("summary failed");
        });

        await runAutoCompact(controller, frames, 2);

        // The whole point: no `session_compact` is emitted on this path, so
        // without the `finally` unwind the record would latch forever and every
        // later prompt would burn the full awaitCompactionEnd timeout.
        assert.equal(adapter.isCompressing(CWD, SESSION), false);
        assert.equal(await adapter.awaitCompactionEnd(CWD, SESSION, 50), true);
    });

    it("still emits a finished frame when compaction never commits", async () => {
        const { adapter, frames } = newAdapter();
        const controller = newController(adapter, async () => {
            throw new Error("cancelled by hook");
        });

        await runAutoCompact(controller, frames, 2);

        assert.deepEqual(
            frames.map((f) => f.method),
            ["session.compaction_started", "session.compaction_finished"],
            "desktop must receive a finished frame so the input freeze lifts",
        );
    });

    it("classifies failure reason on the finished frame when compaction throws", async () => {
        const { adapter, frames } = newAdapter();
        const controller = newController(adapter, async () => {
            throw new Error("summary failed");
        });

        await runAutoCompact(controller, frames, 2);

        assert.equal(adapter.isCompressing(CWD, SESSION), false);
        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string; failureMessage?: string }
            | undefined;
        assert.ok(finished, "finished frame must be emitted");
        assert.equal(finished.failed, true);
        assert.equal(finished.reason, "harness_error");
        assert.equal(finished.failureMessage, undefined);
    });

    it("classifies 'busy' reason when harness rejects with a busy code", async () => {
        const { adapter, frames } = newAdapter();
        const controller = newController(adapter, async () => {
            throw new AgentHarnessError("busy", "harness is busy");
        });

        await runAutoCompact(controller, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "busy");
    });

    it("classifies 'cancelled' reason when a hook cancels compaction", async () => {
        const { adapter, frames } = newAdapter();
        const controller = newController(adapter, async () => {
            throw new AgentHarnessError("compaction", "compaction cancelled by hook");
        });

        await runAutoCompact(controller, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "cancelled");
    });

    it("classifies 'nothing' reason when harness reports nothing to compact", async () => {
        const { adapter, frames } = newAdapter();
        const controller = newController(adapter, async () => {
            throw new AgentHarnessError("compaction", "Nothing to compact");
        });

        await runAutoCompact(controller, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string; failureMessage?: string }
            | undefined;
        assert.equal(finished?.failed, true);
        assert.equal(finished?.reason, "nothing");
        assert.equal(finished?.failureMessage, undefined);
    });

    it("does not include a reason on the successful finished frame", async () => {
        const { adapter, frames } = newAdapter();
        const controller = newController(adapter, async () => {
            adapter.handleSessionEvent(CWD, SESSION, {
                type: "session_compact",
                compactionEntry: { summary: "ok", fromHook: true },
            });
        });

        await runAutoCompact(controller, frames, 2);

        const finished = frames.find((f) => f.method === "session.compaction_finished")?.params as
            | { failed?: boolean; reason?: string }
            | undefined;
        assert.equal(finished?.failed, false);
        assert.equal(finished?.reason, undefined);
    });
});
