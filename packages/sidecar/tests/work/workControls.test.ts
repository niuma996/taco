import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { WorkService } from "../../src/work/workService.ts";

it("tombstones before waiting for an in-flight send and cannot be resurrected by a late settle", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "taco-work-delete-"));
    let release!: () => void;
    let sending!: () => void;
    const entered = new Promise<void>((resolve) => {
        sending = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    let sends = 0;
    const service = new WorkService({
        root,
        instanceId: "i",
        channels: {
            sendText: async () => {
                sends++;
                sending();
                await blocked;
                return { kind: "confirmed" };
            },
            maxMessageLength: () => 1000,
        },
        resolveRoute: () => undefined,
    });
    t.after(async () => {
        release();
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    const work = await service.controller.start({
        sourceEventId: "delete",
        workspace: "/a",
        parentSessionId: "p",
        childSessionId: "c",
        agentType: "e",
        title: "delete",
        deliverTo: { channelId: "mock", peerId: "p", chatId: "c", bindingId: "test-binding" },
    });
    await service.controller.settle({
        workId: work.workId,
        outcome: "completed",
        resultText: "answer",
        parentWillReply: false,
    });
    await entered;
    let deleted = false;
    const deleting = service.delete(work.workId).then((result) => {
        deleted = true;
        return result;
    });
    // Queue a mutation after markDeleted; it cannot see a live Work snapshot.
    assert.equal(
        await service.store.mutate(work.workId, () => {
            throw new Error("must not mutate deleted record");
        }),
        undefined,
    );
    assert.equal((await service.get(work.workId)).work, null);
    assert.equal(deleted, false);
    await service.deliverer.deliver(work.workId);
    release();
    assert.equal((await deleting).outcome, "deleted");
    await service.controller.settle({
        workId: work.workId,
        outcome: "completed",
        resultText: "late",
        parentWillReply: false,
    });
    assert.equal((await service.get(work.workId)).work, null);
    assert.equal(sends, 1);
    assert.equal((await service.delete(work.workId)).outcome, "deleted");
});
