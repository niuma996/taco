/**
 * WorkController: what settle commits, how the notice reply is captured, and
 * what startup reconciliation does to a Work whose driver died.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ImRoute } from "@taco-ai/protocol";
import type { SendOutboundResult } from "../../src/channels/types.ts";
import {
    SCHEDULED_WORK_RETENTION_PER_JOB,
    templateNotice,
    WORK_RETENTION_COUNT,
    WORK_RETENTION_MS,
    WorkController,
} from "../../src/work/workController.ts";
import {
    type DeliveryClock,
    type DeliverySender,
    systemClock,
    WorkDeliverer,
} from "../../src/work/workDelivery.ts";
import { WorkStore } from "../../src/work/workStore.ts";

class RecordingSender implements DeliverySender {
    readonly texts: string[] = [];
    result: SendOutboundResult = { kind: "confirmed" };
    async sendText(_channel: string, _route: ImRoute, text: string): Promise<SendOutboundResult> {
        this.texts.push(text);
        return this.result;
    }
}

const route: ImRoute = { channelId: "wechat-1", peerId: "peer", chatId: "chat" };

describe("work.controller", () => {
    let root: string;
    let seq = 0;
    let time: number;

    before(() => {
        root = mkdtempSync(join(tmpdir(), "taco-work-ctl-"));
    });
    after(() => rmSync(root, { recursive: true, force: true }));

    /**
     * One clock for controller and deliverer. If they disagreed, a deliverer on
     * real time would see a fake-time grace period as long expired and treat the
     * notice as stale — the tests would be checking the clocks, not the code.
     */
    const testClock: DeliveryClock = {
        now: () => time,
        random: () => 0.5,
        setTimer: (fn, ms) => systemClock.setTimer(fn, ms),
    };

    function rig(instanceId = "inst-1") {
        time = 1_000_000;
        const store = new WorkStore(join(root, `c${seq++}`));
        const sender = new RecordingSender();
        const deliverer = new WorkDeliverer(store, sender, testClock);
        const controller = new WorkController({
            store,
            deliverer,
            instanceId,
            now: () => time,
        });
        return { store, sender, deliverer, controller };
    }

    const launch = (n: number) => ({
        sourceEventId: `subagent:p:${n}`,
        parentSessionId: "p",
        childSessionId: `c${n}`,
        agentType: "explorer",
        title: "Find the leak",
    });

    /** Poll an observable; timer- and IO-driven work cannot be awaited directly. */
    async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            if (await check()) return;
            await new Promise((r) => setTimeout(r, 5));
        }
        assert.fail(`timed out waiting for ${what}`);
    }

    describe("start", () => {
        it("creates a running Work owned by this process", async () => {
            const { controller } = rig("inst-A");
            const work = await controller.start(launch(1));
            assert.equal(work.status, "running");
            assert.equal(work.ownerInstanceId, "inst-A");
            assert.equal(work.attempt.endedAt, undefined);
        });

        it("returns the same Work when the same launch is recorded twice", async () => {
            const { controller, store } = rig();
            const a = await controller.start(launch(1));
            const b = await controller.start(launch(1));
            assert.equal(a.workId, b.workId);
            assert.equal((await store.list()).length, 1);
        });

        it("notifies once, for the creation only", async () => {
            const changes: string[] = [];
            const store = new WorkStore(join(root, `c${seq++}`));
            const controller = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "i",
                onChange: (id) => changes.push(id),
            });
            await controller.start(launch(1));
            await controller.start(launch(1));
            assert.equal(changes.length, 1);
        });
    });

    describe("settle", () => {
        it("commits the result and the delivery intent in one snapshot", async () => {
            const { controller, store } = rig();
            const { workId } = await controller.start(launch(1));
            const settled = await controller.settle({
                workId,
                outcome: "completed",
                resultText: "found it in cache.ts",
                path: "/tmp/r.txt",
                deliverTo: route,
                maxMessageLength: 100,
                parentWillReply: true,
            });
            assert.equal(settled?.status, "completed");
            assert.equal(settled?.result?.completeness, "full");
            assert.equal(settled?.delivery?.status, "pending");
            assert.deepEqual(settled?.delivery?.target, route);
            const onDisk = await store.get(workId);
            assert.equal(onDisk?.revision, settled?.revision, "both parts were written together");
            const ref = onDisk?.result;
            assert.ok(ref);
            const stored = await store.readResult(workId, ref.resultId, ref.checksum);
            assert.equal(stored?.text, "found it in cache.ts");
        });

        it("records nothing to deliver when there is no IM target", async () => {
            const { controller } = rig();
            const { workId } = await controller.start(launch(1));
            const settled = await controller.settle({
                workId,
                outcome: "completed",
                resultText: "done",
                parentWillReply: false,
            });
            assert.equal(settled?.delivery, undefined);
        });

        it("marks a capped run partial and an empty one unavailable", async () => {
            const { controller } = rig();
            const a = await controller.start(launch(1));
            const partial = await controller.settle({
                workId: a.workId,
                outcome: "completed",
                resultText: "half",
                partial: true,
                parentWillReply: false,
            });
            assert.equal(partial?.status, "completed");
            assert.equal(partial?.result?.completeness, "partial");

            const b = await controller.start(launch(2));
            const empty = await controller.settle({
                workId: b.workId,
                outcome: "error",
                resultText: "   ",
                parentWillReply: false,
            });
            assert.equal(empty?.status, "failed");
            assert.equal(empty?.result?.completeness, "unavailable");
        });

        it("a second settle does not rewrite the first outcome", async () => {
            const { controller } = rig();
            const { workId } = await controller.start(launch(1));
            await controller.settle({
                workId,
                outcome: "completed",
                resultText: "ok",
                parentWillReply: false,
            });
            const again = await controller.settle({
                workId,
                outcome: "error",
                resultText: "late failure",
                parentWillReply: false,
            });
            assert.equal(again?.status, "completed");
            assert.equal(again?.result?.summary, "ok");
        });

        it("keeps a long answer's summary short and the full text on disk", async () => {
            const { controller, store } = rig();
            const { workId } = await controller.start(launch(1));
            const text = "word ".repeat(1000);
            const settled = await controller.settle({
                workId,
                outcome: "completed",
                resultText: text,
                parentWillReply: false,
            });
            assert.ok((settled?.result?.summary.length ?? 0) <= 280);
            const r = settled?.result;
            assert.ok(r);
            assert.equal((await store.readResult(workId, r.resultId, r.checksum))?.text, text);
        });
    });

    describe("notice reply", () => {
        async function settledWithReplyPending() {
            const r = rig();
            const { workId } = await r.controller.start(launch(1));
            await r.controller.settle({
                workId,
                outcome: "completed",
                resultText: "the answer",
                deliverTo: route,
                maxMessageLength: 100,
                parentWillReply: true,
            });
            return { ...r, workId };
        }

        it("sends nothing yet: the parent model is expected to write the notice", async () => {
            const { sender, workId, store } = await settledWithReplyPending();
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(sender.texts.length, 0);
            assert.equal((await store.get(workId))?.delivery?.chunks, undefined);
        });

        it("freezes and sends the model's reply, not the template", async () => {
            const { controller, sender, store, workId } = await settledWithReplyPending();
            await controller.completeWithReply(workId, "  The leak was in cache.ts.  ");
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "send",
            );
            assert.deepEqual(sender.texts, ["The leak was in cache.ts."]);
            assert.equal((await store.get(workId))?.delivery?.source, "parentReply");
        });

        it("splits a long reply to the channel's cap", async () => {
            const { controller, sender, store, workId } = await settledWithReplyPending();
            await controller.completeWithReply(workId, "x".repeat(250));
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "send",
            );
            assert.ok(sender.texts.length >= 3);
            for (const t of sender.texts) assert.ok(t.length <= 100);
            assert.equal(sender.texts.join(""), "x".repeat(250));
        });

        it("an empty reply falls back to the template", async () => {
            const { controller, sender, store, workId } = await settledWithReplyPending();
            await controller.completeWithReply(workId, "   ");
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "send",
            );
            assert.match(sender.texts[0] ?? "", /^Background task finished/);
            assert.equal((await store.get(workId))?.delivery?.source, "template");
        });

        it("a failed notice run falls back to the template at once", async () => {
            const { controller, sender, store, workId } = await settledWithReplyPending();
            await controller.replyFailed(workId);
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "send",
            );
            assert.equal((await store.get(workId))?.delivery?.source, "template");
            assert.equal(sender.texts.length, 1);
        });

        it("a frozen message is not replaced by a later reply or failure", async () => {
            const { controller, sender, store, workId } = await settledWithReplyPending();
            await controller.completeWithReply(workId, "first");
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "send",
            );
            await controller.completeWithReply(workId, "second");
            await controller.replyFailed(workId);
            assert.deepEqual(sender.texts, ["first"]);
        });

        it("a notice queued behind a busy parent is handed off: no second copy from here", async () => {
            const { controller, sender, store, workId } = await settledWithReplyPending();
            await controller.handOff(workId);
            await new Promise((r) => setTimeout(r, 20));
            assert.equal((await store.get(workId))?.delivery?.status, "handedOff");
            assert.equal(sender.texts.length, 0);
        });

        it("an unreachable parent sends the template instead", async () => {
            const { controller, sender, store, workId } = await settledWithReplyPending();
            await controller.replyFailed(workId);
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "send",
            );
            assert.equal(sender.texts.length, 1);
        });
    });

    describe("holding replies", () => {
        it("two notice runs on one session: the first to end does not lift the other's hold", () => {
            const { controller } = rig();
            assert.equal(controller.isHoldingReplies("p"), false);
            controller.holdReplies("w-a", "p");
            controller.holdReplies("w-b", "p");
            controller.releaseReplies("w-a");
            assert.equal(controller.isHoldingReplies("p"), true, "w-b is still capturing");
            assert.equal(controller.isCapturing("w-b"), true);
            controller.releaseReplies("w-b");
            assert.equal(controller.isHoldingReplies("p"), false);
        });

        it("a stray release of one Work never lifts another Work's hold", () => {
            const { controller } = rig();
            controller.holdReplies("w-b", "p");
            controller.releaseReplies("w-a");
            controller.releaseReplies("w-a");
            assert.equal(controller.isHoldingReplies("p"), true);
        });

        it("only the held session is affected", () => {
            const { controller } = rig();
            controller.holdReplies("w-a", "p");
            assert.equal(controller.isHoldingReplies("other"), false);
        });

        it("stopCapturing lets the session speak again", () => {
            const { controller } = rig();
            controller.holdReplies("w-a", "p");
            controller.stopCapturing("w-a");
            assert.equal(controller.isHoldingReplies("p"), false);
            controller.releaseReplies("w-a");
            assert.equal(controller.isHoldingReplies("p"), false, "the late release is harmless");
        });
    });

    describe("reconcile", () => {
        it("marks a Work left running by another process as interrupted", async () => {
            const { store } = rig("old-process");
            const old = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "old-process",
                now: () => time,
            });
            const { workId } = await old.start(launch(1));

            const reborn = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "new-process",
                now: () => time,
            });
            const result = await reborn.reconcile();
            assert.equal(result.interrupted, 1);
            const after = await store.get(workId);
            assert.equal(after?.status, "interrupted");
            assert.ok(after?.reason);
            assert.ok(after?.endedAt);
        });

        it("leaves this process's own running Work alone", async () => {
            const { controller, store } = rig("inst-1");
            const { workId } = await controller.start(launch(1));
            const result = await controller.reconcile();
            assert.equal(result.interrupted, 0);
            assert.equal((await store.get(workId))?.status, "running");
        });

        it("never downgrades a Work that finished before the crash", async () => {
            const { controller, store } = rig("old");
            const { workId } = await controller.start(launch(1));
            await controller.settle({
                workId,
                outcome: "completed",
                resultText: "ok",
                parentWillReply: false,
            });
            const reborn = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "new",
                now: () => time,
            });
            assert.equal((await reborn.reconcile()).interrupted, 0);
            assert.equal((await store.get(workId))?.status, "completed");
        });

        it("a restart still delivers a notice the dead process had committed but not sent", async () => {
            // The first process has no channel up: its sender reports unavailable,
            // so the notice is committed and stays pending, exactly as if the
            // process had died before sending. (Using `rig()` here would let its
            // own deliverer race the new one and make the assertion about who won.)
            const store = new WorkStore(join(root, `c${seq++}`));
            const down = new RecordingSender();
            down.result = { kind: "unavailable", code: "not_connected" };
            const old = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, down, testClock),
                instanceId: "old",
                now: () => time,
            });
            const { workId } = await old.start(launch(1));
            await old.settle({
                workId,
                outcome: "completed",
                resultText: "the answer",
                deliverTo: route,
                maxMessageLength: 100,
                parentWillReply: false,
            });
            await until(async () => down.texts.length === 1, "the first attempt");
            assert.equal((await store.get(workId))?.delivery?.status, "pending");

            const sender = new RecordingSender();
            const reborn = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, sender, testClock),
                instanceId: "new",
                now: () => time,
            });
            await reborn.reconcile();
            await reborn.resumeDeliveries();
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "resend",
            );
            assert.match(sender.texts.join(""), /Background task finished/);
            assert.equal(sender.texts.length, 1, "sent exactly once by the new process");
        });

        describe("retention", () => {
            it("removes finished Works past the age limit", async () => {
                const { controller, store } = rig();
                const { workId } = await controller.start(launch(1));
                await controller.settle({
                    workId,
                    outcome: "completed",
                    resultText: "ok",
                    parentWillReply: false,
                });
                time += WORK_RETENTION_MS + 1;
                const result = await controller.reconcile();
                assert.equal(result.pruned, 1);
                assert.equal(await store.get(workId), undefined);
            });

            it("keeps a Work that is still owed a notification, however old", async () => {
                const { controller, store } = rig();
                const { workId } = await controller.start(launch(1));
                await controller.settle({
                    workId,
                    outcome: "completed",
                    resultText: "ok",
                    deliverTo: route,
                    parentWillReply: true,
                });
                time += WORK_RETENTION_MS + 1;
                const result = await controller.reconcile();
                assert.equal(result.pruned, 0);
                assert.ok(await store.get(workId));
            });

            it("keeps a running Work of this process", async () => {
                const { controller, store } = rig();
                const { workId } = await controller.start(launch(1));
                time += WORK_RETENTION_MS + 1;
                await controller.reconcile();
                assert.ok(await store.get(workId));
            });

            it("caps the number of finished Works kept", async () => {
                const { controller, store } = rig();
                const total = WORK_RETENTION_COUNT + 3;
                for (let i = 0; i < total; i++) {
                    time += 1;
                    const { workId } = await controller.start(launch(i));
                    await controller.settle({
                        workId,
                        outcome: "completed",
                        resultText: "x",
                        parentWillReply: false,
                    });
                }
                const result = await controller.reconcile();
                assert.equal(result.pruned, 3);
                assert.equal((await store.list()).length, WORK_RETENTION_COUNT);
            });
        });
    });

    describe("scheduled fires", () => {
        const fire = (jobId: string, n: number) => ({
            sourceEventId: `job:${jobId}:${n}`,
            jobId,
            title: "Daily digest",
            workspace: "/w",
            sessionId: `sched-pin-${jobId}`,
        });

        it("records the fire against its session with no delivery", async () => {
            const { controller, sender } = rig();
            const work = await controller.startScheduled(fire("daily", 1));
            assert.equal(work.kind, "scheduled");
            assert.equal(work.jobId, "daily");
            assert.equal(work.parentSessionId, "sched-pin-daily");
            assert.equal(work.childSessionId, undefined);
            const settled = await controller.settle({
                workId: work.workId,
                outcome: "completed",
                resultText: "all quiet",
                deliver: false,
                parentWillReply: false,
            });
            assert.equal(settled?.result?.summary, "all quiet");
            assert.equal(settled?.delivery, undefined);
            assert.deepEqual(sender.texts, []);
        });

        it("keeps each job's last fires on their own, apart from subagents", async () => {
            const { controller, store } = rig();
            const { workId: subagent } = await controller.start(launch(1));
            await controller.settle({
                workId: subagent,
                outcome: "completed",
                resultText: "x",
                parentWillReply: false,
            });
            const extra = 4;
            for (let i = 0; i < SCHEDULED_WORK_RETENTION_PER_JOB + extra; i++) {
                time += 1;
                for (const jobId of ["busy", "quiet"]) {
                    if (jobId === "quiet" && i > 0) continue;
                    const { workId } = await controller.startScheduled(fire(jobId, i));
                    await controller.settle({
                        workId,
                        outcome: "completed",
                        resultText: `run ${i}`,
                        deliver: false,
                        parentWillReply: false,
                    });
                }
            }
            // Each start trims the finished fires to the budget while the new
            // one is still running, so the job never holds more than budget + 1.
            const busy = (await store.list()).filter((w) => w.jobId === "busy");
            assert.equal(busy.length, SCHEDULED_WORK_RETENTION_PER_JOB + 1);
            await controller.reconcile();
            const afterBoot = await store.list();
            assert.equal(
                afterBoot.filter((w) => w.jobId === "busy").length,
                SCHEDULED_WORK_RETENTION_PER_JOB,
            );
            assert.equal(afterBoot.filter((w) => w.jobId === "quiet").length, 1);
            assert.ok(
                afterBoot.some((w) => w.workId === subagent),
                "subagent Work survives",
            );
            const newest = afterBoot
                .filter((w) => w.jobId === "busy")
                .map((w) => w.result?.summary);
            assert.ok(newest.includes(`run ${SCHEDULED_WORK_RETENTION_PER_JOB + extra - 1}`));
            assert.ok(!newest.includes("run 0"));
        });

        it("tells an interrupted fire that the job runs again, not to continue a subagent", async () => {
            const { store } = rig("old-process");
            const old = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "old-process",
                now: () => time,
            });
            const { workId } = await old.startScheduled(fire("daily", 1));
            const next = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "new-process",
                now: () => time,
            });
            await next.reconcile();
            const record = await store.get(workId);
            assert.equal(record?.status, "interrupted");
            assert.match(record?.reason ?? "", /next scheduled time/);
            assert.equal(record?.delivery, undefined, "no target was frozen, so nothing is sent");
        });
    });

    describe("resume and interruption", () => {
        function reborn(store: WorkStore, sender: RecordingSender): WorkController {
            return new WorkController({
                store,
                deliverer: new WorkDeliverer(store, sender, testClock),
                instanceId: "new-process",
                now: () => time,
            });
        }

        it("reopens an interrupted Work and settles it from the resumed run", async () => {
            const { store } = rig("old-process");
            const old = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "old-process",
                now: () => time,
            });
            const { workId } = await old.start(launch(1));
            const next = reborn(store, new RecordingSender());
            await next.reconcile();
            assert.equal((await store.get(workId))?.status, "interrupted");

            const reopened = await next.resumeAttempt(workId);
            assert.equal(reopened?.status, "running");
            const settled = await next.settle({
                workId,
                outcome: "completed",
                resultText: "finished after resume",
                parentWillReply: false,
            });
            assert.equal(settled?.status, "completed");
            assert.equal(settled?.result?.completeness, "full");
            assert.equal(settled?.result?.summary, "finished after resume");
        });

        it("cancels an interruption notice that has not gone out yet", async () => {
            const { store } = rig("old-process");
            const old = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "old-process",
                now: () => time,
            });
            const { workId } = await old.start({
                ...launch(5),
                deliverTo: route,
                maxMessageLength: 2000,
            });
            const sender = new RecordingSender();
            sender.result = { kind: "unavailable", code: "not_connected" };
            const next = reborn(store, sender);
            await next.reconcile();
            await until(() => sender.texts.length === 1, "the failed first attempt");
            assert.equal((await store.get(workId))?.delivery?.status, "pending");

            const reopened = await next.resumeAttempt(workId);
            assert.equal(reopened?.status, "running");
            assert.equal(
                reopened?.delivery?.status,
                "cancelled",
                "a resume makes the interruption notice stale",
            );
        });

        it("does not reopen a Work that already ended", async () => {
            const { controller } = rig();
            const { workId } = await controller.start(launch(2));
            await controller.settle({
                workId,
                outcome: "completed",
                resultText: "ok",
                parentWillReply: false,
            });
            const reopened = await controller.resumeAttempt(workId);
            assert.equal(reopened?.status, "completed");
        });

        it("queues an interruption notice to the target frozen at launch", async () => {
            const { store } = rig("old-process");
            const old = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, new RecordingSender(), testClock),
                instanceId: "old-process",
                now: () => time,
            });
            const { workId } = await old.start({
                ...launch(3),
                deliverTo: route,
                maxMessageLength: 2000,
            });

            const sender = new RecordingSender();
            await reborn(store, sender).reconcile();
            await until(() => sender.texts.length === 1, "the interruption notice");
            assert.match(sender.texts[0] ?? "", /interrupted/i);
            assert.match(sender.texts[0] ?? "", /Find the leak/);
            await until(
                async () => (await store.get(workId))?.delivery?.status === "confirmed",
                "the notice to be confirmed",
            );
            const after = await store.get(workId);
            assert.equal(after?.delivery?.status, "confirmed");
            assert.equal(after?.delivery?.source, "template");
        });

        it("a declined settle neither pushes nor delivers", async () => {
            const store = new WorkStore(join(root, `c${seq++}`));
            const sender = new RecordingSender();
            const changes: string[] = [];
            const controller = new WorkController({
                store,
                deliverer: new WorkDeliverer(store, sender, testClock),
                instanceId: "inst-1",
                now: () => time,
                onChange: (id) => changes.push(id),
            });
            const { workId } = await controller.start(launch(4));
            await controller.settle({
                workId,
                outcome: "completed",
                resultText: "ok",
                deliverTo: route,
                parentWillReply: false,
            });
            await until(() => sender.texts.length === 1, "the first notice");
            const changesBefore = changes.length;
            const textsBefore = sender.texts.length;

            const again = await controller.settle({
                workId,
                outcome: "error",
                resultText: "late failure",
                deliverTo: route,
                parentWillReply: false,
            });
            assert.equal(again?.status, "completed");
            assert.equal(changes.length, changesBefore, "no redundant change push");
            assert.equal(sender.texts.length, textsBefore, "no second delivery");
        });
    });

    describe("templateNotice", () => {
        const base = {
            agentType: "explorer",
            title: "Find the leak",
            excerpt: "answer",
            completeness: "full" as const,
        };

        it("names the outcome and includes the answer", () => {
            assert.match(
                templateNotice({ ...base, outcome: "completed" }),
                /finished: Find the leak\n\nanswer/,
            );
            assert.match(templateNotice({ ...base, outcome: "error" }), /failed: Find the leak/);
            assert.match(templateNotice({ ...base, outcome: "aborted" }), /stopped: Find the leak/);
        });

        it("says when the answer is partial", () => {
            assert.match(
                templateNotice({ ...base, outcome: "completed", completeness: "partial" }),
                /partial/,
            );
        });

        it("falls back to the agent type when there is no title, and says when there is no output", () => {
            const text = templateNotice({
                ...base,
                title: "  ",
                excerpt: "",
                outcome: "completed",
            });
            assert.match(text, /finished: explorer/);
            assert.match(text, /No output was produced/);
        });

        it("never carries a local filesystem path", () => {
            const text = templateNotice({
                ...base,
                outcome: "completed",
                path: "/Users/someone/.taco/results/x.txt",
            });
            assert.doesNotMatch(text, /\/Users\/|\.taco/);
        });
    });
});
