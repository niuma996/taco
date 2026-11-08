import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { AgentSpawner } from "../../src/runtime/subagent/agentSpawner.ts";
import type { BackgroundWorkHooks, ParentNoticeOutcome } from "../../src/work/workHooks.ts";
import { WorkParentNotice } from "../../src/work/workParentNotice.ts";
import { resumeAttempt } from "../../src/work/workState.ts";
import { WorkStore } from "../../src/work/workStore.ts";
import { WORK_SCHEMA_VERSION, type WorkRecord } from "../../src/work/workTypes.ts";

async function rig(t: TestContext, delivery = true) {
    const root = await mkdtemp(join(tmpdir(), "work-parent-notice-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new WorkStore(root);
    const record: WorkRecord = {
        schemaVersion: WORK_SCHEMA_VERSION,
        workId: "w-notice",
        revision: 1,
        kind: "subagent",
        title: "Find the leak",
        sourceEventId: "source",
        parentSessionId: "parent",
        childSessionId: "child",
        ownerInstanceId: "instance-1",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        endedAt: 2,
        attempt: { attemptId: "a-1", startedAt: 1, endedAt: 2 },
        ...(delivery
            ? {
                  delivery: {
                      deliveryId: "d-1",
                      target: { channelId: "im", peerId: "peer", chatId: "chat" },
                      status: "pending" as const,
                      maxMessageLength: 1000,
                      confirmedChunks: 0,
                      attempts: 0,
                      createdAt: 2,
                  },
              }
            : {}),
    };
    await store.createIfAbsent(record);
    const notices = new WorkParentNotice(store, "instance-1", () => 10);
    return { root, store, notices, workId: record.workId };
}

it("claims model awareness only once when live completion and attach flush race", async (t) => {
    const { notices, workId } = await rig(t);
    const decisions = await Promise.all([notices.begin(workId), notices.begin(workId)]);
    assert.deepEqual(decisions.map((d) => d.mode).sort(), ["capture", "skip"]);
    const claimed = decisions.find((d) => d.mode === "capture");
    assert.ok(claimed?.claimId);
    assert.equal(await notices.end(workId, claimed.claimId, { status: "completed" }), true);
    assert.deepEqual(await notices.begin(workId), { mode: "skip" });
});

function noticeSpawner(
    notices: WorkParentNotice,
    parent: { prompt(text: string): Promise<unknown>; enqueue(): Promise<unknown> } | undefined,
    guard?: BackgroundWorkHooks["runParentNotice"],
    beforeEnd?: (held: number) => void,
) {
    let holds = 0;
    const outcomes: ParentNoticeOutcome[] = [];
    const spawner = Object.assign(Object.create(AgentSpawner.prototype), {
        workHooks: {
            runParentNotice: guard,
            beginParentNotice: (id: string, tracked?: boolean) => notices.begin(id, tracked),
            endParentNotice: async (id: string, claimId: string, outcome: ParentNoticeOutcome) => {
                beforeEnd?.(holds);
                outcomes.push(outcome);
                await notices.end(id, claimId, outcome);
            },
            onNoticeRunStart: () => holds++,
            onNoticeRunRelease: () => holds--,
        },
        sessionRegistry: { getAttached: () => parent },
    }) as {
        deliverNotice(
            parent: string,
            text: string,
            id: string,
            trackedOnly: boolean,
            tracked: boolean,
        ): Promise<boolean>;
    };
    return {
        deliver: (workId: string, tracked = true) =>
            spawner.deliverNotice(asSessionId("parent"), "notice", workId, false, tracked),
        held: () => holds,
        outcomes,
    };
}

it("keeps a tracked busy notice pending without putting it in the ordinary followUp queue", async (t) => {
    const { notices, workId } = await rig(t);
    let busy = true;
    let queued = 0;
    let calls = 0;
    const runner = noticeSpawner(notices, {
        prompt: async () => {
            calls++;
            if (busy) throw Object.assign(new Error("busy"), { _tag: "LaneBusy" });
            assert.equal(runner.held(), 1);
            return { role: "assistant", content: [{ type: "text", text: "found it" }] };
        },
        enqueue: async () => {
            queued++;
            return { mode: "queued" };
        },
    });
    assert.equal(await runner.deliver(workId), false);
    assert.equal(queued, 0);
    assert.equal(runner.held(), 0);
    busy = false;
    assert.equal(await runner.deliver(workId), true);
    assert.equal(calls, 2);
    assert.equal(runner.held(), 0);
    assert.equal(await runner.deliver(workId), true);
    assert.equal(calls, 2);
});

it("holds the reply until freezing has finished, including a failing end write", async (t) => {
    const { notices, workId } = await rig(t);
    const runner = noticeSpawner(
        notices,
        {
            prompt: async () => ({
                role: "assistant",
                content: [{ type: "text", text: "actual reply" }],
            }),
            enqueue: async () => assert.fail("must not enqueue"),
        },
        undefined,
        (held) => {
            assert.equal(held, 1);
            throw new Error("cannot persist reply");
        },
    );
    await assert.rejects(runner.deliver(workId), /cannot persist reply/);
    assert.equal(runner.held(), 0);
});

it("does not keep retrying an ambiguous claim after its end write failed", async (t) => {
    const { notices, store, workId } = await rig(t);
    const decision = await notices.begin(workId);
    assert.ok(decision.claimId);
    const mutate = store.mutate.bind(store);
    store.mutate = async () => {
        throw new Error("disk unavailable");
    };
    await assert.rejects(
        notices.end(workId, decision.claimId, { status: "completed" }),
        /disk unavailable/,
    );
    store.mutate = mutate;
    assert.deepEqual(await notices.begin(workId), { mode: "skip" });
});

it("holds a late tracked reply until it finishes even when its template is already confirmed", async (t) => {
    const { notices, workId, store } = await rig(t);
    await store.mutate(workId, (r) => {
        assert.ok(r.delivery);
        return { ...r, delivery: { ...r.delivery, status: "confirmed", chunks: ["template"] } };
    });
    const runner = noticeSpawner(notices, {
        prompt: async () => {
            assert.equal(runner.held(), 1);
            return { role: "assistant", content: [{ type: "text", text: "late reply" }] };
        },
        enqueue: async () => assert.fail("tracked notice must not enqueue"),
    });
    assert.equal(await runner.deliver(workId), true);
    assert.deepEqual(runner.outcomes, [{ status: "completed", reply: "late reply" }]);
    assert.equal(runner.held(), 0);
});

it("preserves pending through concurrent flush while a busy live prompt releases its claim", async (t) => {
    const { notices, workId } = await rig(t);
    let reject!: (e: Error) => void;
    let admitted!: () => void;
    let calls = 0;
    const started = new Promise<void>((resolve) => {
        admitted = resolve;
    });
    const runner = noticeSpawner(notices, {
        prompt: async () => {
            if (++calls > 1) throw Object.assign(new Error("busy"), { _tag: "LaneBusy" });
            admitted();
            return new Promise((_, fail) => {
                reject = fail;
            });
        },
        enqueue: async () => assert.fail("tracked notice must not enqueue"),
    });
    const live = runner.deliver(workId);
    await started;
    try {
        assert.equal(await runner.deliver(workId), false);
    } finally {
        reject(Object.assign(new Error("busy"), { _tag: "LaneBusy" }));
        await live.catch(() => undefined);
    }
    assert.equal((await notices.begin(workId)).mode, "capture");
});

it("does not replay a tracked prompt after an admitted failure", async (t) => {
    const { notices, workId } = await rig(t);
    let calls = 0;
    const runner = noticeSpawner(notices, {
        prompt: async () => {
            calls++;
            throw new Error("model failed");
        },
        enqueue: async () => assert.fail("tracked notice must not enqueue"),
    });
    await assert.rejects(runner.deliver(workId), /model failed/);
    assert.equal(runner.held(), 0);
    assert.equal(await runner.deliver(workId), true);
    assert.equal(calls, 1);
});

it("preserves legacy busy queueing for old pending records with no matching Work", async (t) => {
    const { notices } = await rig(t);
    let queued = 0;
    const runner = noticeSpawner(notices, {
        prompt: async () => {
            throw Object.assign(new Error("busy"), { _tag: "LaneBusy" });
        },
        enqueue: async () => {
            queued++;
            return { mode: "queued" };
        },
    });
    assert.equal(await runner.deliver("legacy", false), true);
    assert.equal(queued, 1);
    assert.deepEqual(runner.outcomes, []);
});

it("keeps template delivery separate from parent awareness and captures a late reply", async (t) => {
    const { notices, store, workId } = await rig(t);
    await store.mutate(workId, (r) => {
        assert.ok(r.delivery);
        return { ...r, delivery: { ...r.delivery, status: "confirmed", chunks: ["template"] } };
    });
    assert.equal((await notices.begin(workId)).mode, "capture");
    assert.equal((await store.get(workId))?.delivery?.status, "confirmed");
    assert.deepEqual((await store.get(workId))?.delivery?.chunks, ["template"]);
});

it("releases only its own unadmitted claim so a busy parent can be retried", async (t) => {
    const { notices, workId } = await rig(t);
    const first = await notices.begin(workId);
    assert.ok(first.claimId);
    assert.equal(await notices.end(workId, "stale", { status: "not_run" }), false);
    assert.equal((await notices.begin(workId)).mode, "skip");
    assert.equal(await notices.end(workId, first.claimId, { status: "not_run" }), true);
    const second = await notices.begin(workId);
    assert.equal(second.mode, "capture");
    assert.notEqual(second.claimId, first.claimId);
    assert.equal(await notices.end(workId, first.claimId, { status: "not_run" }), false);
    assert.equal((await notices.begin(workId)).mode, "skip");
});

it("does not reaccept an ambiguous claim after restart or let a foreign owner release it", async (t) => {
    const { notices, root, workId } = await rig(t);
    const decision = await notices.begin(workId);
    assert.ok(decision.claimId);
    const restarted = new WorkParentNotice(new WorkStore(root), "instance-2");
    assert.equal((await restarted.begin(workId)).mode, "skip");
    assert.equal(await restarted.end(workId, decision.claimId, { status: "not_run" }), false);
});

it("does not let a notice from the previous attempt claim or complete the resumed result", async (t) => {
    const { notices, store, workId } = await rig(t, false);
    const first = await notices.begin(workId);
    assert.ok(first.claimId);
    await store.mutate(workId, (current) =>
        resumeAttempt({ ...current, status: "interrupted" }, { attemptId: "a-2", now: 20 }),
    );
    assert.equal(
        await notices.end(workId, first.claimId, { status: "completed", reply: "old text" }),
        false,
    );
    await store.mutate(workId, (current) => ({ ...current, status: "completed" }));
    assert.equal((await notices.begin(workId)).mode, "silent");
});

it("retains legacy fallback only when no Work matches and skips deleted Work", async (t) => {
    const { notices, store, workId } = await rig(t);
    assert.deepEqual(await notices.begin("legacy", false), { mode: "legacy" });
    await store.markDeleted(workId);
    assert.deepEqual(await notices.begin(workId), { mode: "skip" });
});

it("uses a durable silent claim for desktop Work without IM delivery", async (t) => {
    const { notices, workId } = await rig(t, false);
    const decision = await notices.begin(workId);
    assert.equal(decision.mode, "silent");
    assert.ok(decision.claimId);
});

it("releases a claim when the parent is not attached", async (t) => {
    const { notices, workId } = await rig(t);
    const runner = noticeSpawner(notices, undefined);
    assert.equal(await runner.deliver(workId), false);
    assert.deepEqual(runner.outcomes, [{ status: "not_run" }]);
    assert.equal((await notices.begin(workId)).mode, "capture");
});

it("never falls back to a live prompt if claim persistence fails", async (t) => {
    const { notices, workId } = await rig(t);
    notices.begin = async () => {
        throw new Error("disk full");
    };
    const runner = noticeSpawner(notices, {
        prompt: async () => assert.fail("must persist before admitting a parent prompt"),
        enqueue: async () => assert.fail("tracked notice must not enqueue"),
    });
    await assert.rejects(runner.deliver(workId), /disk full/);
    assert.deepEqual(runner.outcomes, []);
});

it("keeps a known tracked notice pending when its Work is missing", async (t) => {
    const { notices } = await rig(t);
    const runner = noticeSpawner(notices, {
        prompt: async () => assert.fail("missing tracked Work must not fall back to a live prompt"),
        enqueue: async () => assert.fail("missing tracked Work must not enqueue"),
    });
    assert.equal(await runner.deliver("missing"), false);
});

it("runs a tracked parent notice only through the current-claim admission guard", async (t) => {
    const { notices, workId } = await rig(t);
    let guarded = false;
    const runner = noticeSpawner(
        notices,
        {
            prompt: async () => {
                assert.equal(guarded, true);
                return { role: "assistant", content: [{ type: "text", text: "found it" }] };
            },
            enqueue: async () => assert.fail("tracked notice must not enqueue"),
        },
        async (id, claimId, sessionId, run) => {
            assert.equal(id, workId);
            assert.ok(claimId);
            assert.equal(sessionId, "parent");
            guarded = true;
            return run();
        },
    );
    assert.equal(await runner.deliver(workId), true);
    assert.equal(guarded, true);
});

it("does not prompt when the Work claim is superseded before admission", async (t) => {
    const { notices, workId } = await rig(t);
    const runner = noticeSpawner(
        notices,
        {
            prompt: async () => assert.fail("superseded Work must not run"),
            enqueue: async () => assert.fail("superseded Work must not enqueue"),
        },
        async () => {
            throw new Error("parent notice was superseded");
        },
    );
    await assert.rejects(runner.deliver(workId), /parent notice was superseded/);
    assert.equal(runner.held(), 0);
    assert.deepEqual(runner.outcomes, [{ status: "not_run" }]);
});

it("never prompts for a corrupt snapshot, including derived legacy provenance", async (t) => {
    const { notices, workId, root } = await rig(t);
    await writeFile(join(root, workId, "work.json"), "{");
    const runner = noticeSpawner(notices, {
        prompt: async () => assert.fail("corrupt Work must not fall back to a live prompt"),
        enqueue: async () => assert.fail("corrupt Work must not enqueue"),
    });
    assert.equal(await runner.deliver(workId), false);
    assert.equal(await runner.deliver(workId, false), false);
});

it("does not retain pending when resume has invalidated an in-flight notice", async (t) => {
    const { notices, store, workId } = await rig(t);
    await notices.begin(workId);
    await store.mutate(workId, (r) => ({ ...r, status: "running" }));
    assert.deepEqual(await notices.begin(workId), { mode: "skip" });
});

it("skips a notice made stale by resume or a previous handoff", async (t) => {
    const { notices, store, workId } = await rig(t);
    for (const status of ["cancelled", "handedOff"] as const) {
        await store.mutate(workId, (r) => {
            assert.ok(r.delivery);
            return { ...r, delivery: { ...r.delivery, status } };
        });
        assert.equal((await notices.begin(workId)).mode, "skip");
    }
});
