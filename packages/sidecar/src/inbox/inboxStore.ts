import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { restrictOwner } from "../lib/fsPermissions.ts";
import {
    INBOX_SCHEMA_VERSION,
    type InboxBatch,
    type InboxMessage,
    type InboxReceipt,
    inboxBatchId,
    inboxReceiptId,
    inboxSourceKey,
} from "./inboxTypes.ts";

export class InboxStore {
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly root: string) {}

    async accept(message: InboxMessage): Promise<{ receipt: InboxReceipt; created: boolean }> {
        const sourceKey = inboxSourceKey(message);
        const receiptId = inboxReceiptId(sourceKey);
        return this.withQueue(receiptId, async () => {
            const existing = await this.readReceipt(receiptId);
            if (existing) return { receipt: existing, created: false };
            const now = message.receivedAt;
            const receipt: InboxReceipt = {
                schemaVersion: INBOX_SCHEMA_VERSION,
                receiptId,
                sourceKey,
                bindingId: message.bindingId,
                channelId: message.channelId,
                peerId: message.peerId,
                chatId: message.chatId,
                platformMessageId: message.platformMessageId,
                workspace: message.workspace,
                payload: { text: message.text, ...(message.media ? { media: message.media } : {}) },
                status: "ready",
                revision: 0,
                receivedAt: message.receivedAt,
                updatedAt: now,
                attempts: 0,
            };
            await this.writeJson(this.receiptPath(receiptId), receipt);
            return { receipt, created: true };
        });
    }

    async get(receiptId: string): Promise<InboxReceipt | undefined> {
        return this.readReceipt(receiptId);
    }

    async list(): Promise<InboxReceipt[]> {
        const dir = join(this.root, "receipts");
        const entries = await readdir(dir).catch(() => [] as string[]);
        const receipts: InboxReceipt[] = [];
        for (const entry of entries) {
            if (!entry.endsWith(".json")) continue;
            const value = await this.readReceipt(entry.slice(0, -5));
            if (value) receipts.push(value);
        }
        return receipts.sort((a, b) => a.receivedAt - b.receivedAt);
    }

    async freezeBatch(
        workspace: string,
        receiptIds: readonly string[],
        now = Date.now(),
    ): Promise<{ batch: InboxBatch; created: boolean }> {
        if (receiptIds.length === 0) throw new Error("cannot freeze an empty inbox batch");
        const batchId = inboxBatchId(workspace, receiptIds);
        return this.withQueue(`batch:${workspace}`, async () => {
            const existing = await this.getBatch(batchId);
            if (existing) return { batch: existing, created: false };
            const receipts = await Promise.all(receiptIds.map((id) => this.get(id)));
            if (receipts.some((receipt) => !receipt)) throw new Error("inbox receipt not found");
            if (receipts.some((receipt) => receipt?.workspace !== workspace))
                throw new Error("inbox receipt workspace mismatch");
            if (receipts.some((receipt) => receipt?.status !== "ready"))
                throw new Error("receipt is not ready for batching");
            const batch: InboxBatch = {
                schemaVersion: INBOX_SCHEMA_VERSION,
                batchId,
                workspace,
                memberReceiptIds: [...receiptIds],
                createdAt: now,
                frozenAt: now,
            };
            await this.writeJson(this.batchPath(batchId), batch);
            for (const receipt of receipts) {
                if (!receipt) continue;
                await this.mutate(receipt, (current) => ({
                    ...current,
                    status: "batched",
                    batchId,
                    updatedAt: now,
                }));
            }
            return { batch, created: true };
        });
    }

    async getBatch(batchId: string): Promise<InboxBatch | undefined> {
        try {
            return JSON.parse(await readFile(this.batchPath(batchId), "utf8")) as InboxBatch;
        } catch {
            return undefined;
        }
    }

    async markProcessing(
        receipt: InboxReceipt,
    ): Promise<{ receipt: InboxReceipt; changed: boolean }> {
        return this.mutate(receipt, (current) =>
            current.status === "batched" || current.status === "ready"
                ? {
                      ...current,
                      status: "processing",
                      attempts: current.attempts + 1,
                      updatedAt: Date.now(),
                  }
                : undefined,
        );
    }

    async markCompleted(receipt: InboxReceipt): Promise<InboxReceipt> {
        const result = await this.mutate(receipt, (current) =>
            current.status === "processing"
                ? { ...current, status: "completed", updatedAt: Date.now() }
                : undefined,
        );
        return result.receipt;
    }

    async markFailed(receipt: InboxReceipt, error: string): Promise<InboxReceipt> {
        const result = await this.mutate(receipt, (current) => ({
            ...current,
            status: "failed",
            lastError: error,
            updatedAt: Date.now(),
        }));
        return result.receipt;
    }

    async resetForRetry(receipt: InboxReceipt): Promise<InboxReceipt> {
        const result = await this.mutate(receipt, (current) =>
            current.status === "failed"
                ? { ...current, status: "ready", lastError: undefined, updatedAt: Date.now() }
                : undefined,
        );
        return result.receipt;
    }

    private async mutate(
        expected: InboxReceipt,
        update: (current: InboxReceipt) => InboxReceipt | undefined,
    ): Promise<{ receipt: InboxReceipt; changed: boolean }> {
        return this.withQueue(expected.receiptId, async () => {
            const current = await this.readReceipt(expected.receiptId);
            if (!current) throw new Error("inbox receipt not found");
            if (current.revision !== expected.revision)
                throw new Error("inbox receipt revision mismatch");
            const next = update(current);
            if (!next) return { receipt: current, changed: false };
            const receipt = { ...next, revision: current.revision + 1 };
            await this.writeJson(this.receiptPath(receipt.receiptId), receipt);
            return { receipt, changed: true };
        });
    }

    private receiptPath(id: string): string {
        return join(this.root, "receipts", `${id}.json`);
    }
    private batchPath(id: string): string {
        return join(this.root, "batches", `${id}.json`);
    }

    private async readReceipt(id: string): Promise<InboxReceipt | undefined> {
        try {
            return JSON.parse(await readFile(this.receiptPath(id), "utf8")) as InboxReceipt;
        } catch {
            return undefined;
        }
    }

    private async writeJson(path: string, value: unknown): Promise<void> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await restrictOwner(dirname(path), 0o700);
        const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
            await restrictOwner(temp);
            await rename(temp, path);
        } finally {
            await unlink(temp).catch(() => undefined);
        }
    }

    private async withQueue<T>(id: string, run: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(id) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.queues.set(id, tail);
        await previous.catch(() => undefined);
        try {
            return await run();
        } finally {
            release();
            if (this.queues.get(id) === tail) this.queues.delete(id);
        }
    }
}
