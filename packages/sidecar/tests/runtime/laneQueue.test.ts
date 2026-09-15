/**
 * Lane steering-queue enqueue gating.
 *
 * pi's steer / followUp are unconditional inbox writes, so the "is there
 * anything that will consume this" decision lives in enqueueLaneMessage. The
 * load-bearing detail is that only an operation of kind "run" consumes these
 * queues: a compaction occupies the lane without draining them, so treating
 * "an operation is present" as queueable would write a message that sits
 * unconsumed until the next prompt.
 *
 * Run: pnpm --filter @taco-ai/sidecar test tests/runtime/laneQueue.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cancelLaneQueued, enqueueLaneMessage } from "../../src/runtime/harness/laneQueue.ts";
import type { AgentLane } from "../../src/runtime/pi/types.ts";

type OperationKind = "run" | "compaction" | "navigation";

interface RecordedEnqueue {
    method: "steer" | "followUp";
    text: string;
}

function makeLane(
    currentKind: OperationKind | null,
    opts: { entryId?: string; failWith?: unknown } = {},
): { lane: AgentLane; calls: RecordedEnqueue[] } {
    const calls: RecordedEnqueue[] = [];
    const write = async (method: "steer" | "followUp", text: string) => {
        calls.push({ method, text });
        if (opts.failWith !== undefined) return { ok: false as const, error: opts.failWith };
        return { ok: true as const, value: { entryId: opts.entryId ?? "entry-1" } };
    };
    const lane = {
        inspectExecution: async () => ({
            current: currentKind === null ? null : { id: "op-1", kind: currentKind },
        }),
        steer: (text: string) => write("steer", text),
        followUp: (text: string) => write("followUp", text),
    } as unknown as AgentLane;
    return { lane, calls };
}

describe("enqueueLaneMessage — only an active run consumes the queues", () => {
    it("run in flight → queued, echoing pi's entryId", async () => {
        const { lane, calls } = makeLane("run", { entryId: "entry-42" });
        const result = await enqueueLaneMessage(lane, "steer", "hello");
        assert.deepEqual(result, { mode: "queued", entryId: "entry-42" });
        assert.deepEqual(calls, [{ method: "steer", text: "hello" }]);
    });

    it("compaction in flight → idle, and nothing is written to the inbox", async () => {
        const { lane, calls } = makeLane("compaction");
        const result = await enqueueLaneMessage(lane, "steer", "hello");
        assert.deepEqual(result, { mode: "idle" });
        // The whole point: a compaction does not drain the steer queue, so
        // writing here would strand the message until the next prompt.
        assert.deepEqual(calls, []);
    });

    it("navigation in flight → idle (also does not drain the queues)", async () => {
        const { lane, calls } = makeLane("navigation");
        assert.deepEqual(await enqueueLaneMessage(lane, "steer", "hi"), { mode: "idle" });
        assert.deepEqual(calls, []);
    });

    it("lane idle → idle, so the caller can fall back to prompt", async () => {
        const { lane, calls } = makeLane(null);
        assert.deepEqual(await enqueueLaneMessage(lane, "followUp", "hi"), { mode: "idle" });
        assert.deepEqual(calls, []);
    });

    it("followUp routes to the followUp queue, not steer", async () => {
        const { lane, calls } = makeLane("run");
        await enqueueLaneMessage(lane, "followUp", "later");
        assert.deepEqual(calls, [{ method: "followUp", text: "later" }]);
    });

    it("a rejected write surfaces as a throw, not a silent idle", async () => {
        const { lane } = makeLane("run", { failWith: new Error("lane closed") });
        await assert.rejects(() => enqueueLaneMessage(lane, "steer", "hello"));
    });
});

describe("cancelLaneQueued", () => {
    for (const kind of ["cancelled", "already_consumed", "not_found"] as const) {
        it(`passes through "${kind}" as a normal outcome`, async () => {
            const lane = {
                cancelQueued: async () => ({ ok: true as const, value: { kind } }),
            } as unknown as AgentLane;
            assert.equal(await cancelLaneQueued(lane, "entry-1"), kind);
        });
    }

    it("a rejected cancel surfaces as a throw", async () => {
        const lane = {
            cancelQueued: async () => ({ ok: false as const, error: new Error("closed") }),
        } as unknown as AgentLane;
        await assert.rejects(() => cancelLaneQueued(lane, "entry-1"));
    });
});
