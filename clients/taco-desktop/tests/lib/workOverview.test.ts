import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkListResult, WorkSummary } from "@taco-ai/protocol";
import {
    appendPage,
    applyList,
    attentionCount,
    createCoalescer,
    EMPTY_WORK_STATE,
    groupWork,
    pushMatters,
    ResponseGate,
} from "../../src/lib/workOverview.ts";

let n = 0;
function work(over: Partial<WorkSummary> = {}): WorkSummary {
    n += 1;
    return {
        workId: `w-${n}`,
        revision: 1,
        kind: "subagent",
        title: `job ${n}`,
        agentType: "explorer",
        status: "completed",
        createdAt: n,
        updatedAt: n,
        parentSessionId: "p",
        childSessionId: `c${n}`,
        needsAttention: false,
        ...over,
    };
}

function list(over: Partial<WorkListResult> = {}): WorkListResult {
    return { instanceId: "inst-1", active: [], terminal: [], ...over };
}

describe("workOverview.groupWork", () => {
    it("splits the daemon's active list into running and attention by status", () => {
        const running = work({ status: "running" });
        const lost = work({ status: "interrupted", needsAttention: true });
        const gaveUp = work({ needsAttention: true });
        const done = work();
        const groups = groupWork([running, lost, gaveUp], [done]);
        assert.deepEqual(
            groups.running.map((w) => w.workId),
            [running.workId],
        );
        assert.deepEqual(
            groups.attention.map((w) => w.workId),
            [lost.workId, gaveUp.workId],
        );
        assert.deepEqual(
            groups.finished.map((w) => w.workId),
            [done.workId],
        );
    });

    it("a running Work the daemon flags for attention is shown as attention, once", () => {
        const odd = work({ status: "running", needsAttention: true });
        const groups = groupWork([odd], []);
        assert.equal(groups.running.length, 0);
        assert.equal(groups.attention.length, 1);
    });
});

describe("workOverview.applyList", () => {
    it("is not loaded before the first answer, and loaded after, even if empty", () => {
        assert.equal(EMPTY_WORK_STATE.loaded, false);
        const state = applyList(list());
        assert.equal(state.loaded, true);
        assert.equal(state.groups.finished.length, 0);
    });

    it("converges: the same daemon answer yields the same state however it got there", () => {
        const a = work({ status: "running" });
        const b = work();
        const answer = list({ active: [a], terminal: [b] });
        assert.deepEqual(applyList(answer), applyList(structuredClone(answer)));
    });

    it("a replacement daemon's answer replaces the old rows entirely", () => {
        const old = applyList(list({ instanceId: "inst-1", terminal: [work()] }));
        const next = applyList(list({ instanceId: "inst-2" }));
        assert.equal(next.instanceId, "inst-2");
        assert.equal(next.groups.finished.length, 0);
        assert.notEqual(old.groups.finished.length, next.groups.finished.length);
    });

    it("counts attention rows for a badge", () => {
        const state = applyList(
            list({ active: [work({ needsAttention: true }), work({ status: "running" })] }),
        );
        assert.equal(attentionCount(state), 1);
    });
});

describe("workOverview.appendPage", () => {
    it("appends finished Works and carries the new cursor", () => {
        const first = [work(), work()];
        const second = [work(), work()];
        const state = applyList(list({ terminal: first, nextCursor: "c1" }));
        const next = appendPage(state, list({ terminal: second, nextCursor: undefined }));
        assert.equal(next.groups.finished.length, 4);
        assert.equal(next.nextCursor, undefined);
    });

    it("skips a row that is already shown", () => {
        const a = work();
        const state = applyList(list({ terminal: [a], nextCursor: "c1" }));
        const next = appendPage(state, list({ terminal: [a, work()] }));
        assert.equal(next.groups.finished.length, 2);
    });

    it("drops a page that came from another daemon", () => {
        const state = applyList(
            list({ instanceId: "inst-1", terminal: [work()], nextCursor: "c1" }),
        );
        const next = appendPage(state, list({ instanceId: "inst-2", terminal: [work()] }));
        assert.equal(next, state);
    });
});

describe("workOverview.pushMatters", () => {
    const state = applyList(list({ instanceId: "inst-1" }));

    it("a push naming Works matters", () => {
        assert.equal(pushMatters(state, { instanceId: "inst-1", workIds: ["w-1"] }), true);
    });

    it("a push from a different daemon always matters, even when empty", () => {
        assert.equal(pushMatters(state, { instanceId: "inst-2", workIds: [] }), true);
    });

    it("an empty push from the same daemon is ignored", () => {
        assert.equal(pushMatters(state, { instanceId: "inst-1", workIds: [] }), false);
    });

    it("before the first answer any push from anywhere matters", () => {
        assert.equal(pushMatters(EMPTY_WORK_STATE, { instanceId: "x", workIds: [] }), true);
    });
});

describe("workOverview.ResponseGate", () => {
    it("only the newest request may apply its response", () => {
        const gate = new ResponseGate();
        const first = gate.begin();
        const second = gate.begin();
        assert.equal(first(), false, "a slower, older response is stale");
        assert.equal(second(), true);
    });

    it("invalidate retires every request in flight", () => {
        const gate = new ResponseGate();
        const before = gate.begin();
        gate.invalidate();
        assert.equal(before(), false, "issued before the reconnect, must not land after it");
        const after = gate.begin();
        assert.equal(after(), true);
    });

    it("a response that arrives during a newer fetch is dropped, not merged", () => {
        const gate = new ResponseGate();
        const slow = gate.begin();
        const push = gate.begin();
        assert.equal(slow(), false);
        assert.equal(push(), true);
    });
});

describe("workOverview.createCoalescer", () => {
    it("runs once for a burst of triggers", async () => {
        let runs = 0;
        const c = createCoalescer(() => {
            runs += 1;
        }, 10);
        for (let i = 0; i < 12; i++) c.trigger();
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(runs, 1);
    });

    it("runs again for a later trigger", async () => {
        let runs = 0;
        const c = createCoalescer(() => {
            runs += 1;
        }, 5);
        c.trigger();
        await new Promise((r) => setTimeout(r, 30));
        c.trigger();
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(runs, 2);
    });

    it("cancel drops a pending run", async () => {
        let runs = 0;
        const c = createCoalescer(() => {
            runs += 1;
        }, 10);
        c.trigger();
        c.cancel();
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(runs, 0);
    });
});
