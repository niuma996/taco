import { makeImCwd } from "@taco-ai/protocol";
import type { InboxStore } from "../inbox/inboxStore.ts";
import type { InboxBatch, InboxPreparation } from "../inbox/inboxTypes.ts";
import type { ChannelInboundMessage, ChannelIngress } from "./types.ts";

export function combineInbound(messages: readonly ChannelInboundMessage[]): ChannelInboundMessage {
    const first = messages[0];
    if (!first) throw new Error("cannot submit an empty inbound batch");
    if (
        messages.some(
            (m) =>
                m.channelId !== first.channelId ||
                m.peerId !== first.peerId ||
                m.chatId !== first.chatId ||
                m.bindingId !== first.bindingId,
        )
    )
        throw new Error("inbound batch conversation or binding mismatch");
    const media = messages.flatMap((m) => m.media ?? []);
    return {
        ...first,
        kind: media.length ? "media" : "text",
        text: messages
            .map((m) => m.text.trim())
            .filter(Boolean)
            .join("\n\n"),
        media: media.length ? media : undefined,
    };
}

/** Owns receipt admission. Legacy dispatch is deliberately not replayed after an ambiguous crash. */
export class InboxIngress implements ChannelIngress {
    private readonly preparing = new Set<string>();

    constructor(
        private readonly channelId: string,
        private readonly store: InboxStore,
        private readonly binding: () => string | undefined,
        private readonly route: (
            message: ChannelInboundMessage,
        ) => Promise<{ workspace: string; sessionId: string }>,
        private readonly dispatch: (
            message: ChannelInboundMessage,
            target: { workspace: string; sessionId: string },
            batch: InboxBatch,
        ) => Promise<{ sessionId: string; failed?: boolean }>,
    ) {}

    submit(message: ChannelInboundMessage) {
        return this.submitBatch([message]);
    }

    async submitBatch(messages: readonly ChannelInboundMessage[]) {
        const combined = combineInbound(messages);
        const bindingId = this.requireBinding(combined);
        const workspace = makeImCwd(this.channelId, combined.peerId, combined.chatId);
        const ids: string[] = [];
        for (const message of messages) {
            const { receipt } = await this.store.accept({
                ...message,
                bindingId,
                workspace,
                receivedAt: Date.now(),
            });
            ids.push(receipt.receiptId);
        }
        const batches = await this.store.freezeAvailable(workspace, ids);
        let target: { workspace: string; sessionId: string } | undefined;
        let batchId: string | undefined;
        for (const batch of batches) {
            batchId = batch.batchId;
            target = batch.target ?? target ?? (await this.route(combined));
            this.requireBinding({ ...combined, bindingId });
            if (!(await this.store.claimBatch(batch.batchId, target))) continue;
            try {
                const members = await Promise.all(
                    batch.memberReceiptIds.map((id) => this.store.get(id)),
                );
                const payload = combineInbound(
                    members.map((member) => {
                        if (!member) throw new Error("inbox receipt disappeared");
                        return { ...member, ...member.payload };
                    }),
                );
                this.requireBinding({ ...payload, bindingId });
                const result = await this.dispatch(
                    {
                        ...payload,
                        platformMessageId: batch.batchId,
                    },
                    target,
                    batch,
                );
                await this.store.finishBatch(batch.batchId, result.failed);
            } catch (error) {
                await this.store.finishBatch(batch.batchId, true);
                throw error;
            }
        }
        if (!target) target = await this.route(combined);
        return { sessionId: target.sessionId, batchId };
    }

    async prepare(
        message: ChannelInboundMessage,
        source: InboxPreparation,
        prepare: () => Promise<ChannelInboundMessage | undefined>,
    ) {
        const bindingId = this.requireBinding(message);
        const { receipt } = await this.store.accept({
            ...message,
            bindingId,
            workspace: makeImCwd(this.channelId, message.peerId, message.chatId),
            receivedAt: Date.now(),
            preparation: source,
        });
        if (receipt.batchId || this.preparing.has(receipt.receiptId)) return undefined;
        if (receipt.status === "ready")
            return {
                ...message,
                ...receipt.payload,
                platformMessageId: receipt.platformMessageId,
                bindingId,
            };
        this.preparing.add(receipt.receiptId);
        try {
            const value = await prepare();
            if (!value) {
                await this.store.markFailed(receipt, "media_preparation_failed");
                return undefined;
            }
            this.requireBinding({ ...message, bindingId });
            await this.store.markPrepared(receipt, { text: value.text, media: value.media });
            return { ...value, platformMessageId: receipt.platformMessageId, bindingId };
        } catch (error) {
            await this.store.markFailed(receipt, "media_preparation_failed");
            throw error;
        } finally {
            this.preparing.delete(receipt.receiptId);
        }
    }

    async recoverPrepared(
        format: string,
        prepare: (data: unknown) => Promise<ChannelInboundMessage | undefined>,
        ready: (message: ChannelInboundMessage) => void,
    ) {
        const bindingId = this.binding();
        if (!bindingId) return;
        for (const receipt of await this.store.list()) {
            if (
                receipt.channelId !== this.channelId ||
                receipt.bindingId !== bindingId ||
                receipt.batchId ||
                receipt.preparation?.format !== format
            )
                continue;
            const message = { ...receipt, ...receipt.payload };
            const value = await this.prepare(message, receipt.preparation, () =>
                prepare(receipt.preparation?.data),
            );
            if (value) ready(value);
        }
        for (const batch of await this.store.listBatches()) {
            if (batch.state && batch.state !== "frozen") continue;
            const members = await Promise.all(
                batch.memberReceiptIds.map((id) => this.store.get(id)),
            );
            if (
                members.some(
                    (m) => !m || m.channelId !== this.channelId || m.bindingId !== bindingId,
                )
            )
                continue;
            await this.submitBatch(
                members.map((member) => {
                    if (!member) throw new Error("inbox receipt disappeared");
                    return { ...member, ...member.payload };
                }),
            );
        }
    }

    private requireBinding(message: ChannelInboundMessage) {
        if (message.channelId !== this.channelId)
            throw new Error("inbound channel identity mismatch");
        const bindingId = this.binding();
        if (!bindingId) throw new Error("channel binding unavailable");
        if (message.bindingId !== undefined && message.bindingId !== bindingId)
            throw new Error("channel binding changed");
        return bindingId;
    }
}
