import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { InboxStore } from "../../src/inbox/inboxStore.ts";
import type { InboxMessage } from "../../src/inbox/inboxTypes.ts";

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
    return {
        bindingId: "account-a",
        channelId: "wechat",
        peerId: "peer-a",
        chatId: "chat-a",
        platformMessageId: "m-1",
        workspace: "im://wechat/peer-a/chat-a",
        text: "hello",
        receivedAt: 1,
        ...overrides,
    };
}

async function withStore(
    t: { after(fn: () => Promise<void>): void },
    run: (store: InboxStore, root: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "taco-inbox-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    await run(new InboxStore(root), root);
}

it("deduplicates by binding and conversation", async (t) => {
    await withStore(t, async (store) => {
        const first = await store.accept(message());
        const duplicate = await store.accept(message({ text: "redelivered" }));
        const otherAccount = await store.accept(message({ bindingId: "account-b" }));
        const otherChat = await store.accept(message({ chatId: "chat-b" }));
        assert.equal(first.created, true);
        assert.equal(duplicate.created, false);
        assert.equal(duplicate.receipt.payload.text, "hello");
        assert.equal(otherAccount.created, true);
        assert.equal(otherChat.created, true);
        assert.equal((await store.list()).length, 3);
    });
});

it("freezes ordered members and rejects a changed frozen batch", async (t) => {
    await withStore(t, async (store) => {
        const a = await store.accept(message({ platformMessageId: "a", receivedAt: 1 }));
        const b = await store.accept(
            message({ platformMessageId: "b", receivedAt: 2, text: "world" }),
        );
        const frozen = await store.freezeBatch(message().workspace, [
            a.receipt.receiptId,
            b.receipt.receiptId,
        ]);
        const replay = await store.freezeBatch(message().workspace, [
            a.receipt.receiptId,
            b.receipt.receiptId,
        ]);
        assert.equal(frozen.created, true);
        assert.equal(replay.batch.batchId, frozen.batch.batchId);
        assert.deepEqual(replay.batch.memberReceiptIds, [a.receipt.receiptId, b.receipt.receiptId]);
        await assert.rejects(
            store.freezeBatch(message().workspace, [a.receipt.receiptId]),
            /receipt is not ready/,
        );
    });
});

it("survives restart and checks revisions on transitions", async (t) => {
    await withStore(t, async (store, root) => {
        const accepted = await store.accept(message());
        const batch = await store.freezeBatch(message().workspace, [accepted.receipt.receiptId]);
        const restarted = new InboxStore(root);
        assert.deepEqual(
            await restarted.get(accepted.receipt.receiptId),
            await store.get(accepted.receipt.receiptId),
        );
        assert.deepEqual(await restarted.getBatch(batch.batch.batchId), batch.batch);
        const ready = await restarted.get(accepted.receipt.receiptId);
        assert.ok(ready);
        const processing = await restarted.markProcessing(ready);
        await assert.rejects(restarted.markCompleted(ready), /revision mismatch/);
        assert.equal((await restarted.markCompleted(processing.receipt)).status, "completed");
    });
});

it("keeps failed media receipts retryable with the same identity", async (t) => {
    await withStore(t, async (store) => {
        const accepted = await store.accept(
            message({ media: [{ kind: "file", source: { kind: "url", value: "one-shot" } }] }),
        );
        const failed = await store.markFailed(accepted.receipt, "media_download_failed");
        assert.equal(failed.status, "failed");
        assert.equal((await store.resetForRetry(failed)).receiptId, failed.receiptId);
    });
});

it("repairs a freeze interrupted after its batch commit", async (t) => {
    await withStore(t, async (store, root) => {
        const a = (await store.accept(message({ platformMessageId: "a" }))).receipt;
        const b = (await store.accept(message({ platformMessageId: "b" }))).receipt;
        const batch = (await store.freezeBatch(message().workspace, [a.receiptId, b.receiptId]))
            .batch;
        await writeFile(join(root, "receipts", `${a.receiptId}.json`), JSON.stringify(a));
        await writeFile(join(root, "receipts", `${b.receiptId}.json`), JSON.stringify(b));
        const restored = new InboxStore(root);
        await restored.freezeBatch(message().workspace, batch.memberReceiptIds);
        assert.equal((await restored.get(a.receiptId))?.batchId, batch.batchId);
        await assert.rejects(
            restored.freezeBatch(message().workspace, [a.receiptId]),
            /ready|frozen/,
        );
    });
});

it("rejects cross-account batches and duplicate member ids", async (t) => {
    await withStore(t, async (store) => {
        const a = (await store.accept(message())).receipt;
        const b = (await store.accept(message({ bindingId: "account-b" }))).receipt;
        await assert.rejects(
            store.freezeBatch(a.workspace, [a.receiptId, b.receiptId]),
            /binding|account|conversation/,
        );
        await assert.rejects(
            store.freezeBatch(a.workspace, [a.receiptId, a.receiptId]),
            /duplicate/,
        );
    });
});

it("does not overwrite corrupt receipts or permit path traversal", async (t) => {
    await withStore(t, async (store, root) => {
        const a = (await store.accept(message())).receipt;
        await writeFile(join(root, "receipts", `${a.receiptId}.json`), "broken");
        await assert.rejects(store.accept(message()), /snapshot|JSON|corrupt/);
        await assert.rejects(store.get("../outside"), /unsafe/);
        await assert.rejects(store.getBatch("../outside"), /unsafe/);
    });
});

it("bounds fallback dedup across window boundaries and preserves distinct platform times", async (t) => {
    await withStore(t, async (store) => {
        const a = await store.accept(message({ platformMessageId: "", receivedAt: 29_990 }));
        const b = await store.accept(message({ platformMessageId: "", receivedAt: 30_010 }));
        assert.equal(b.receipt.receiptId, a.receipt.receiptId);
        assert.equal(
            (await store.accept(message({ platformMessageId: "", receivedAt: 60_020 }))).created,
            true,
        );
        assert.equal(
            (
                await store.accept(
                    message({ platformMessageId: "", platformTimestamp: 10, receivedAt: 60_030 }),
                )
            ).created,
            true,
        );
        assert.equal(
            (
                await store.accept(
                    message({ platformMessageId: "", platformTimestamp: 11, receivedAt: 60_031 }),
                )
            ).created,
            true,
        );
    });
});

it("purges terminal payload before dedup metadata while retaining pending sources", async (t) => {
    await withStore(t, async (store) => {
        const terminal = (await store.accept(message())).receipt;
        const pending = (await store.accept(message({ platformMessageId: "pending" }))).receipt;
        const batch = (await store.freezeBatch(terminal.workspace, [terminal.receiptId])).batch;
        await store.claimBatch(batch.batchId, { workspace: terminal.workspace, sessionId: "s" });
        await store.finishBatch(batch.batchId);
        const now = Date.now();
        await store.cleanup(now + 8 * 86_400_000);
        assert.equal((await store.get(terminal.receiptId))?.payload.text, "");
        assert.equal((await store.get(pending.receiptId))?.payload.text, "hello");
        assert.equal((await store.accept(message())).created, false);
        await store.cleanup(now + 31 * 86_400_000);
        assert.equal(await store.get(terminal.receiptId), undefined);
        assert.equal((await store.get(pending.receiptId))?.status, "ready");
    });
});
