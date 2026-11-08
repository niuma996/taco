import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { WAITING_WORK_STALE_MS } from "../../src/work/workController.ts";
import type { DeliveryClock } from "../../src/work/workDelivery.ts";
import { WorkService } from "../../src/work/workService.ts";
import { WorkStore } from "../../src/work/workStore.ts";

class FakeClock implements DeliveryClock {
    time = 1_000_000;
    timers = new Set<{ at: number; fn: () => void }>();
    now = () => this.time;
    random = () => 0.5;
    setTimer(fn: () => void, ms: number): () => void {
        const timer = { at: this.time + ms, fn };
        this.timers.add(timer);
        return () => {
            this.timers.delete(timer);
        };
    }
    advance(ms: number): void {
        this.time += ms;
        for (const timer of [...this.timers]) {
            if (timer.at > this.time) continue;
            this.timers.delete(timer);
            timer.fn();
        }
    }
}

async function rig(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "work-waiting-maintenance-"));
    const clock = new FakeClock();
    const options = {
        root,
        clock,
        instanceId: "i",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 2000,
        },
        resolveRoute: () => undefined,
    };
    const service = new WorkService(options);
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    const work = await service.controller.startScheduled({
        sourceEventId: "j:f",
        jobId: "j",
        title: "Review",
        workspace: "/a",
        sessionId: "s",
    });
    const waiting = { toolCallId: "q", toolName: "askUser" as const, sessionId: "s" };
    await service.controller.waitForInput(work.workId, waiting);
    return { root, clock, service, workId: work.workId, waiting, options };
}

it("persists waiting time independently of later snapshot updates", async (t) => {
    const { service, root, clock, workId } = await rig(t);
    const since = clock.now();
    const waiting = await new WorkStore(root).get(workId);
    assert.equal(waiting?.waitingSince, since);
    assert.equal(waiting?.expiresAt, since + WAITING_WORK_STALE_MS);
    clock.advance(WAITING_WORK_STALE_MS);
    await service.store.mutate(workId, (current) => ({ ...current, updatedAt: clock.now() }));
    await service.controller.reconcile();
    const expired = await service.store.get(workId);
    assert.equal(expired?.status, "interrupted");
    assert.equal(expired?.waiting, undefined);
    assert.equal(expired?.expiredInteraction?.toolCallId, "q");
    assert.equal(expired?.expiredInteraction?.sessionId, "s");
    assert.equal(expired?.expiredInteraction?.workspace, "/a");
    assert.equal(expired?.expiredInteraction?.expiresAt, since + WAITING_WORK_STALE_MS);
});

it("migrates legacy waiting deadlines once from the ended attempt", async (t) => {
    const { service, clock, workId } = await rig(t);
    const since = clock.now();
    await service.store.mutate(workId, (current) => ({
        ...current,
        waitingSince: undefined,
        expiresAt: undefined,
        updatedAt: since + 123,
    }));
    await service.controller.reconcile();
    const first = await service.store.get(workId);
    assert.equal(first?.waitingSince, since);
    assert.equal(first?.expiresAt, since + WAITING_WORK_STALE_MS);
    clock.advance(1000);
    await service.store.mutate(workId, (current) => ({ ...current, updatedAt: clock.now() }));
    await service.controller.reconcile();
    const second = await service.store.get(workId);
    assert.equal(second?.waitingSince, first?.waitingSince);
    assert.equal(second?.expiresAt, first?.expiresAt);
});

it("preserves a waiting deadline through busy admission rollback", async (t) => {
    const { service, clock, workId } = await rig(t);
    const snapshot = await service.store.get(workId);
    assert.ok(snapshot);
    clock.advance(100);
    const resumed = await service.controller.resumeAttempt(workId, "q");
    assert.ok(resumed);
    clock.advance(100);
    await service.controller.restoreWaiting(snapshot, resumed.attempt.attemptId);
    const restored = await service.store.get(workId);
    assert.equal(restored?.waitingSince, snapshot.waitingSince);
    assert.equal(restored?.expiresAt, clock.now() - 200 + WAITING_WORK_STALE_MS);
});

it("declines an expired interaction at atomic answer admission", async (t) => {
    const { service, clock, workId } = await rig(t);
    clock.advance(WAITING_WORK_STALE_MS);
    const resumed = await service.controller.resumeAttempt(workId, "q");
    assert.equal(resumed, undefined);
    const current = await service.store.get(workId);
    assert.equal(current?.status, "interrupted");
    assert.equal(current?.expiredInteraction?.toolCallId, "q");
});

it("does not interrupt an answer that won the race with the startup scan", async (t) => {
    const { service, clock, workId } = await rig(t);
    clock.advance(WAITING_WORK_STALE_MS);
    const mutate = service.store.mutate.bind(service.store);
    let raced = false;
    service.store.mutate = async (id, update) => {
        if (!raced && id === workId) {
            raced = true;
            await mutate(id, (current) => ({
                ...current,
                status: "running",
                waiting: undefined,
                attempt: { attemptId: "new", startedAt: clock.now() },
            }));
        }
        return mutate(id, update);
    };
    await service.controller.reconcile();
    assert.equal((await service.store.get(workId))?.status, "running");
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("maintenance did not reach the expected state");
}

it("expires waiting periodically without restarting and stops its timer", async (t) => {
    const { service, clock, workId } = await rig(t);
    await service.start();
    assert.equal(clock.timers.size, 1);
    clock.advance(WAITING_WORK_STALE_MS);
    await until(async () => (await service.store.get(workId))?.status === "interrupted");
    await until(() => clock.timers.size === 1);
    const expired = await service.store.get(workId);
    assert.equal(expired?.expiredInteraction?.toolCallId, "q");
    assert.match(expired?.reason ?? "", /seven days/);
    service.stop();
    assert.equal(clock.timers.size, 0);
    clock.advance(WAITING_WORK_STALE_MS);
    assert.equal(clock.timers.size, 0);
});

it("prunes finished work during periodic maintenance", async (t) => {
    const { service, clock, workId } = await rig(t);
    await service.controller.resumeAttempt(workId, "q");
    await service.controller.settle({
        workId,
        outcome: "completed",
        resultText: "done",
        parentWillReply: false,
    });
    await service.start();
    assert.equal(clock.timers.size, 1);
    clock.advance(31 * 24 * 60 * 60_000);
    await until(async () => (await service.store.get(workId)) === undefined);
});

it("does not rearm maintenance after stop while a pass is in flight", async (t) => {
    const { service, clock } = await rig(t);
    await service.start();
    assert.equal(clock.timers.size, 1);
    let release!: () => void;
    let entered = false;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    service.controller.maintain = async () => {
        entered = true;
        await held;
        return { interrupted: 0, pruned: 0 };
    };
    clock.advance(60_000);
    await until(() => entered);
    service.stop();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(clock.timers.size, 0);
});

it("leaves recovered running operations out of startup fallback interruption", async (t) => {
    const { service, clock, workId } = await rig(t);
    await service.controller.resumeAttempt(workId, "q");
    await service.store.mutate(workId, (current) => ({ ...current, ownerInstanceId: "old" }));
    await service.controller.reconcile(new Set([workId]));
    assert.equal((await service.store.get(workId))?.status, "running");
    clock.advance(1);
    await service.controller.reconcile();
    assert.equal((await service.store.get(workId))?.status, "interrupted");
});

it("does not arm maintenance when stopped during asynchronous startup", async (t) => {
    const { service, clock } = await rig(t);
    const resume = service.controller.resumeDeliveries.bind(service.controller);
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    service.controller.resumeDeliveries = async () => {
        entered = true;
        await held;
        await resume();
    };
    const starting = service.start();
    await until(() => entered);
    service.stop();
    release();
    await starting;
    assert.equal(clock.timers.size, 0);
});

it("keeps a changed deadline when a stale scan reaches the mutation queue", async (t) => {
    const { service, clock, workId } = await rig(t);
    clock.advance(WAITING_WORK_STALE_MS);
    const mutate = service.store.mutate.bind(service.store);
    let raced = false;
    service.store.mutate = async (id, update) => {
        if (!raced && id === workId) {
            raced = true;
            await mutate(id, (current) => ({ ...current, expiresAt: clock.now() + 1000 }));
        }
        return mutate(id, update);
    };
    await service.controller.reconcile();
    assert.equal((await service.store.get(workId))?.status, "waiting");
    clock.advance(1000);
    await service.controller.reconcile();
    assert.equal((await service.store.get(workId))?.status, "interrupted");
});

it("expires a busy rollback at the original deadline instead of reopening the question", async (t) => {
    const { service, clock, workId } = await rig(t);
    const snapshot = await service.store.get(workId);
    assert.ok(snapshot);
    const admitted = await service.controller.resumeAttempt(workId, "q");
    assert.ok(admitted);
    clock.advance(WAITING_WORK_STALE_MS);
    await service.controller.restoreWaiting(snapshot, admitted.attempt.attemptId);
    const restored = await service.store.get(workId);
    assert.equal(restored?.status, "interrupted");
    assert.equal(restored?.expiredInteraction?.attemptId, snapshot.attempt.attemptId);
    assert.equal(restored?.expiredInteraction?.expiresAt, clock.now());
});

it("uses a stable attempt start when a legacy waiting snapshot has no attempt end", async (t) => {
    const { service, clock, workId } = await rig(t);
    const since = clock.now();
    await service.store.mutate(workId, (current) => ({
        ...current,
        waitingSince: undefined,
        expiresAt: undefined,
        attempt: { attemptId: current.attempt.attemptId, startedAt: since },
        updatedAt: since + WAITING_WORK_STALE_MS - 1,
    }));
    await service.controller.reconcile();
    assert.equal((await service.store.get(workId))?.expiresAt, since + WAITING_WORK_STALE_MS);
});

it("does not interrupt foreign running work during running maintenance", async (t) => {
    const { service, workId } = await rig(t);
    await service.controller.resumeAttempt(workId, "q");
    await service.store.mutate(workId, (current) => ({ ...current, ownerInstanceId: "foreign" }));
    await service.controller.maintain();
    assert.equal((await service.store.get(workId))?.status, "running");
});
