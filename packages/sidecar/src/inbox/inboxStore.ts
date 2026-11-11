import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionTarget } from "@taco-ai/protocol";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { writeJsonAtomic } from "../store/atomicFile.ts";
import { SerialChain } from "../store/serial.ts";
import {
    INBOX_FALLBACK_WINDOW_MS,
    INBOX_SCHEMA_VERSION,
    type InboxBatch,
    type InboxMessage,
    type InboxReceipt,
    inboxBatchId,
    inboxDeliveryIds,
    inboxReceiptId,
    inboxSourceKey,
} from "./inboxTypes.ts";

const receiptPattern = /^i-[a-f0-9]{32}$/;
const batchPattern = /^b-[a-f0-9]{32}$/;
const receiptStatuses = new Set([
    "preparing",
    "ready",
    "batched",
    "processing",
    "completed",
    "failed",
]);

/** Batch snapshots commit membership; receipt projections are repaired before any new write. */
export class InboxStore {
    private readonly chain = new SerialChain();
    private recovered = false;

    constructor(private readonly root: string) {}

    accept(message: InboxMessage): Promise<{ receipt: InboxReceipt; created: boolean }> {
        return this.serial(async () => {
            if (
                ![
                    message.bindingId,
                    message.channelId,
                    message.peerId,
                    message.chatId,
                    message.workspace,
                ].every((v) => typeof v === "string" && v.length > 0)
            )
                throw new Error("inbox source identity is incomplete");
            const [platformMessageId, ...previousIds] = inboxDeliveryIds(message);
            const sourceKey = inboxSourceKey({ ...message, platformMessageId });
            const receiptId = inboxReceiptId(sourceKey);
            let existing = await this.readReceipt(receiptId);
            if (!existing)
                for (const id of previousIds) {
                    const previous = await this.readReceipt(
                        inboxReceiptId(inboxSourceKey({ ...message, platformMessageId: id })),
                    );
                    if (
                        previous &&
                        message.receivedAt - previous.receivedAt <= INBOX_FALLBACK_WINDOW_MS
                    ) {
                        existing = previous;
                        break;
                    }
                }
            if (existing) {
                if (existing.workspace !== message.workspace)
                    throw new Error("inbox receipt workspace mismatch");
                return { receipt: existing, created: false };
            }
            const receipt: InboxReceipt = {
                schemaVersion: INBOX_SCHEMA_VERSION,
                receiptId,
                sourceKey,
                bindingId: message.bindingId,
                channelId: message.channelId,
                peerId: message.peerId,
                chatId: message.chatId,
                platformMessageId,
                platformTimestamp: message.platformTimestamp,
                workspace: message.workspace,
                payload: { text: message.text, ...(message.media ? { media: message.media } : {}) },
                status: message.preparation ? "preparing" : "ready",
                revision: 0,
                receivedAt: message.receivedAt,
                updatedAt: message.receivedAt,
                attempts: 0,
                ...(message.preparation ? { preparation: message.preparation } : {}),
            };
            await this.writeJson(this.receiptPath(receiptId), receipt);
            return { receipt, created: true };
        });
    }

    get(id: string): Promise<InboxReceipt | undefined> {
        return this.serial(() => this.readReceipt(id));
    }
    list(): Promise<InboxReceipt[]> {
        return this.serial(() => this.listReceipts());
    }
    getBatch(id: string): Promise<InboxBatch | undefined> {
        return this.serial(() => this.readBatch(id));
    }
    listBatches(): Promise<InboxBatch[]> {
        return this.serial(() => this.readBatches());
    }

    freezeBatch(
        workspace: string,
        ids: readonly string[],
        now = Date.now(),
    ): Promise<{ batch: InboxBatch; created: boolean }> {
        return this.serial(() => this.freeze(workspace, ids, now));
    }

    /** Only new members form a new batch; a subset replay still refers to its original batch. */
    freezeAvailable(workspace: string, ids: readonly string[]): Promise<InboxBatch[]> {
        return this.serial(async () => {
            const unique = [...new Set(ids)];
            const ready: string[] = [];
            const existing = new Set<string>();
            for (const id of unique) {
                const receipt = await this.readReceipt(id);
                if (!receipt || receipt.workspace !== workspace)
                    throw new Error("inbox receipt workspace mismatch");
                if (receipt.batchId) existing.add(receipt.batchId);
                else if (receipt.status === "ready") ready.push(id);
                else throw new Error("receipt is not ready for batching");
            }
            const batches: InboxBatch[] = [];
            for (const id of existing) {
                const batch = await this.readBatch(id);
                if (!batch) throw new Error("frozen inbox batch is missing");
                batches.push(batch);
            }
            if (ready.length) batches.push((await this.freeze(workspace, ready, Date.now())).batch);
            return batches;
        });
    }

    claimBatch(id: string, target: SessionTarget): Promise<boolean> {
        return this.serial(async () => {
            const batch = await this.readBatch(id);
            if (!batch || batch.workspace !== target.workspace)
                throw new Error("inbox batch target mismatch");
            if (batch.state && batch.state !== "frozen") return false;
            await this.writeJson(this.batchPath(id), {
                ...batch,
                state: "dispatching",
                target,
                updatedAt: Date.now(),
            });
            for (const member of batch.memberReceiptIds) {
                const current = await this.requireReceipt(member);
                await this.writeReceipt({
                    ...current,
                    status: "processing",
                    attempts: current.attempts + 1,
                });
            }
            return true;
        });
    }

    finishBatch(id: string, failed = false): Promise<void> {
        return this.serial(async () => {
            const batch = await this.readBatch(id);
            if (batch?.state !== "dispatching") return;
            await this.writeJson(this.batchPath(id), {
                ...batch,
                state: failed ? "failed" : "submitted",
                updatedAt: Date.now(),
            });
            for (const member of batch.memberReceiptIds) {
                const receipt = await this.requireReceipt(member);
                await this.writeReceipt({ ...receipt, status: failed ? "failed" : "completed" });
            }
        });
    }

    markPrepared(receipt: InboxReceipt, payload: InboxReceipt["payload"]): Promise<InboxReceipt> {
        return this.change(receipt, (current) => {
            if (current.batchId || (current.status !== "preparing" && current.status !== "failed"))
                throw new Error("receipt cannot be prepared");
            return { ...current, status: "ready", payload, lastError: undefined };
        }).then((result) => result.receipt);
    }

    markProcessing(receipt: InboxReceipt): Promise<{ receipt: InboxReceipt; changed: boolean }> {
        return this.change(receipt, (current) =>
            current.status === "batched" || current.status === "ready"
                ? { ...current, status: "processing", attempts: current.attempts + 1 }
                : undefined,
        );
    }
    markCompleted(receipt: InboxReceipt): Promise<InboxReceipt> {
        return this.change(receipt, (current) =>
            current.status === "processing" ? { ...current, status: "completed" } : undefined,
        ).then((r) => r.receipt);
    }
    markFailed(receipt: InboxReceipt, error: string): Promise<InboxReceipt> {
        return this.change(receipt, (current) =>
            current.status === "completed"
                ? undefined
                : { ...current, status: "failed", lastError: error },
        ).then((r) => r.receipt);
    }
    resetForRetry(receipt: InboxReceipt): Promise<InboxReceipt> {
        return this.change(receipt, (current) =>
            current.status === "failed" && !current.batchId
                ? {
                      ...current,
                      status: current.preparation ? "preparing" : "ready",
                      lastError: undefined,
                  }
                : undefined,
        ).then((r) => r.receipt);
    }

    /** Pending payloads are retained; only terminal batches lose content and then dedup metadata. */
    cleanup(
        now = Date.now(),
        payloadMs = 7 * 86_400_000,
        dedupMs = 30 * 86_400_000,
    ): Promise<void> {
        return this.serial(async () => {
            if (dedupMs < payloadMs)
                throw new Error("dedup retention must cover payload retention");
            for (const batch of await this.readBatches()) {
                if (batch.state !== "submitted" && batch.state !== "failed") continue;
                const age = now - (batch.updatedAt ?? batch.frozenAt);
                if (age <= payloadMs) continue;
                // Removing the commit first prevents recovery from resurrecting expired receipts.
                if (age > dedupMs) await rm(this.batchPath(batch.batchId));
                for (const id of batch.memberReceiptIds) {
                    if (age > dedupMs) await rm(this.receiptPath(id), { force: true });
                    else {
                        const receipt = await this.requireReceipt(id);
                        if (receipt.payload.text || receipt.payload.media || receipt.preparation)
                            await this.writeReceipt({
                                ...receipt,
                                payload: { text: "" },
                                preparation: undefined,
                            });
                    }
                }
            }
        });
    }

    private async freeze(workspace: string, ids: readonly string[], now: number) {
        if (!ids.length) throw new Error("cannot freeze an empty inbox batch");
        if (new Set(ids).size !== ids.length) throw new Error("duplicate inbox batch members");
        const id = inboxBatchId(workspace, ids);
        const existing = await this.readBatch(id);
        if (existing) return { batch: existing, created: false };
        const members = await Promise.all(ids.map((member) => this.requireReceipt(member)));
        const first = members[0];
        if (members.some((member) => member.workspace !== workspace))
            throw new Error("inbox receipt workspace mismatch");
        if (
            members.some(
                (member) =>
                    member.bindingId !== first.bindingId ||
                    member.channelId !== first.channelId ||
                    member.peerId !== first.peerId ||
                    member.chatId !== first.chatId,
            )
        )
            throw new Error("inbox batch binding or conversation mismatch");
        if (members.some((member) => member.status !== "ready" || member.batchId))
            throw new Error("receipt is not ready for batching");
        const batch: InboxBatch = {
            schemaVersion: INBOX_SCHEMA_VERSION,
            batchId: id,
            workspace,
            memberReceiptIds: [...ids],
            createdAt: now,
            frozenAt: now,
            state: "frozen",
        };
        await this.writeJson(this.batchPath(id), batch);
        for (const receipt of members)
            await this.writeReceipt({ ...receipt, batchId: id, status: "batched" });
        return { batch, created: true };
    }

    private change(
        expected: InboxReceipt,
        update: (current: InboxReceipt) => InboxReceipt | undefined,
    ) {
        return this.serial(async () => {
            const current = await this.requireReceipt(expected.receiptId);
            if (current.revision !== expected.revision)
                throw new Error("inbox receipt revision mismatch");
            const next = update(current);
            return next
                ? { receipt: await this.writeReceipt(next), changed: true }
                : { receipt: current, changed: false };
        });
    }
    private async writeReceipt(receipt: InboxReceipt): Promise<InboxReceipt> {
        const next = { ...receipt, revision: receipt.revision + 1, updatedAt: Date.now() };
        await this.writeJson(this.receiptPath(next.receiptId), next);
        return next;
    }

    private async recover(): Promise<void> {
        for (const batch of await this.readBatches()) {
            for (const id of batch.memberReceiptIds) {
                const receipt = await this.requireReceipt(id);
                if (
                    receipt.workspace !== batch.workspace ||
                    (receipt.batchId && receipt.batchId !== batch.batchId)
                )
                    throw new Error("conflicting inbox batch membership");
                const status =
                    batch.state === "submitted"
                        ? "completed"
                        : batch.state === "failed"
                          ? "failed"
                          : batch.state === "dispatching"
                            ? "processing"
                            : "batched";
                if (
                    !receipt.batchId ||
                    (batch.state === "submitted" && receipt.status !== "completed") ||
                    (batch.state === "failed" && receipt.status !== "failed") ||
                    (batch.state === "dispatching" && receipt.status === "batched")
                )
                    await this.writeReceipt({ ...receipt, batchId: batch.batchId, status });
            }
        }
        this.recovered = true;
    }
    private serial<T>(run: () => Promise<T>): Promise<T> {
        return this.chain.run(async () => {
            if (!this.recovered) await this.recover();
            try {
                return await run();
            } catch (error) {
                this.recovered = false;
                throw error;
            }
        });
    }

    private receiptPath(id: string): string {
        if (!receiptPattern.test(id)) throw new Error("unsafe inbox receipt id");
        return join(this.root, "receipts", `${id}.json`);
    }
    private batchPath(id: string): string {
        if (!batchPattern.test(id)) throw new Error("unsafe inbox batch id");
        return join(this.root, "batches", `${id}.json`);
    }
    private async requireReceipt(id: string) {
        const receipt = await this.readReceipt(id);
        if (!receipt) throw new Error("inbox receipt not found");
        return receipt;
    }
    private async readReceipt(id: string): Promise<InboxReceipt | undefined> {
        const value = await this.readJson<InboxReceipt>(this.receiptPath(id));
        if (
            value &&
            (value.schemaVersion !== INBOX_SCHEMA_VERSION ||
                value.receiptId !== id ||
                typeof value.sourceKey !== "string" ||
                inboxReceiptId(value.sourceKey) !== id ||
                !receiptStatuses.has(value.status) ||
                !Number.isInteger(value.revision) ||
                typeof value.payload?.text !== "string")
        )
            throw new Error("unrecognized inbox receipt snapshot");
        return value;
    }
    private async readBatch(id: string): Promise<InboxBatch | undefined> {
        const value = await this.readJson<InboxBatch>(this.batchPath(id));
        if (
            value &&
            (value.schemaVersion !== INBOX_SCHEMA_VERSION ||
                value.batchId !== id ||
                !Array.isArray(value.memberReceiptIds) ||
                inboxBatchId(value.workspace, value.memberReceiptIds) !== id)
        )
            throw new Error("unrecognized inbox batch snapshot");
        return value;
    }
    private async readJson<T>(path: string): Promise<T | undefined> {
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
        try {
            const value: unknown = JSON.parse(raw);
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new Error("invalid snapshot");
            return value as T;
        } catch {
            throw new Error("corrupt inbox snapshot");
        }
    }
    private async files(kind: "receipts" | "batches"): Promise<string[]> {
        try {
            return (await readdir(join(this.root, kind)))
                .filter(
                    (f) =>
                        (kind === "receipts" ? receiptPattern : batchPattern).test(
                            f.replace(/\.json$/, ""),
                        ) && f.endsWith(".json"),
                )
                .sort();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    }
    private async listReceipts(): Promise<InboxReceipt[]> {
        const values = await Promise.all(
            (await this.files("receipts")).map((f) => this.readReceipt(f.slice(0, -5))),
        );
        return values
            .filter((v): v is InboxReceipt => v !== undefined)
            .sort((a, b) => a.receivedAt - b.receivedAt || a.receiptId.localeCompare(b.receiptId));
    }
    private async readBatches(): Promise<InboxBatch[]> {
        const values = await Promise.all(
            (await this.files("batches")).map((f) => this.readBatch(f.slice(0, -5))),
        );
        return values.filter((v): v is InboxBatch => v !== undefined);
    }
    private async writeJson(path: string, value: unknown): Promise<void> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await restrictOwner(this.root, 0o700);
        await restrictOwner(dirname(path), 0o700);
        await writeJsonAtomic(path, value, { secure: true });
    }
}
