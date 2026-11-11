import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
