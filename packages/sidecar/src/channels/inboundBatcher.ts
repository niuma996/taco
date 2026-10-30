import type { ChannelContext, ChannelMediaRef, Logger } from "./types.ts";

/**
 * Groups one chat's inbound messages that arrive close together into a batch.
 *
 * An IM platform delivers a picture and the words sent with it as separate
 * messages, with no ordering between them: the picture has to upload first, so
 * a caption typed after it often arrives before it. Submitted one by one, the
 * caption starts a run on its own and the picture becomes a follow-up the
 * model only sees after it has already answered. Holding a chat's messages
 * until the chat goes quiet lets the pair reach the model as one prompt.
 *
 * Each item is a promise so the slow part (a media download) starts the moment
 * the message arrives and runs while the window is still open; the batch is
 * handed over once the window closes and every item has settled.
 *
 * The batch stays open while any item is still in flight. A large file can
 * take a minute to download, and the platform delivers the caption that
 * belongs to it only after the download finishes — a batch that closed on a
 * timer would leave that caption to start a second, separate turn.
 */

/**
 * Quiet window a chat must stay quiet for before its batch is handed over.
 *
 * Long enough to cover the gap between a picture and the caption that
 * follows it, short enough that an ordinary message is not held back.
 */
export const DEFAULT_MERGE_WINDOW_MS = 3000;
/**
 * Upper bound on how long a batch stays open.
 *
 * Above the platform's 60s media download timeout on purpose: a download that
 * outlived this would let the batch close under a caption still waiting for
 * that very download.
 */
export const DEFAULT_MERGE_MAX_WAIT_MS = 90_000;

export interface InboundBatcherOptions<T> {
    /**
     * How long a chat must stay quiet before its batch is handed over.
     *
     * Measured from the last message's arrival, so a caption that follows its
     * picture joins the same batch. Long enough to cover the gap between the
     * two messages arriving, short enough that an ordinary chat message is
     * not held back.
     */
    readonly quietMs: number;
    /**
     * Upper bound on how long a batch may stay open, so a peer who keeps
     * typing does not postpone their own first message indefinitely.
     *
     * Deliberately above the platform's media download timeout: a download
     * that outlives this would let the batch close under a caption that is
     * still waiting for that very download.
     */
    readonly maxWaitMs: number;
    /** Receives one chat's batch, items in arrival order. */
    readonly flush: (key: string, items: T[]) => void;
}

interface PendingBatch<T> {
    readonly items: Promise<T>[];
    /** Items that have not settled yet — a media download in flight. */
    pending: number;
    /** When the last message arrived. The quiet window runs from here. */
    lastArrivalAt: number;
    /** When the batch opened. Bounds how long it can be held open. */
    openedAt: number;
    timer: ReturnType<typeof setTimeout> | undefined;
}

export class InboundBatcher<T> {
    private readonly batches = new Map<string, PendingBatch<T>>();
    /**
     * Each key's last hand-over. Items settle in any order (a text message is
     * ready before a download), so a later batch waits for the previous one to
     * be handed over first.
     */
    private readonly tails = new Map<string, Promise<void>>();
    private closed = false;

    constructor(private readonly options: InboundBatcherOptions<T>) {}

    push(key: string, item: Promise<T>): void {
        if (this.closed) return;
        // A rejected item must not take its batch down with it; the caller's
        // promise is expected to settle to a value it can skip.
        item.catch(() => {});
        const now = Date.now();
        let batch = this.batches.get(key);
        if (!batch) {
            batch = {
                items: [],
                pending: 0,
                lastArrivalAt: now,
                openedAt: now,
                timer: undefined,
            };
            this.batches.set(key, batch);
        }
        batch.items.push(item);
        batch.pending += 1;
        batch.lastArrivalAt = now;
        // A message in flight cancels the quiet timer: the batch cannot be
        // handed over while a download is still running.
        this.disarm(batch);
        const onSettled = (): void => {
            batch.pending -= 1;
            this.arm(key, batch);
        };
        void item.then(onSettled, onSettled);
    }

    /** Drop every open batch without handing it over. */
    dispose(): void {
        this.closed = true;
        for (const batch of this.batches.values()) this.disarm(batch);
        this.batches.clear();
    }

    private disarm(batch: PendingBatch<T>): void {
        if (!batch.timer) return;
        clearTimeout(batch.timer);
        batch.timer = undefined;
    }

    /**
     * Schedule the hand-over of a settled batch.
     *
     * A batch with an item still in flight waits — the timer is re-armed when
     * that item settles. Otherwise the hand-over runs one quiet window after
     * the last arrival, so a caption that shows up in the meantime joins.
     */
    private arm(key: string, batch: PendingBatch<T>): void {
        if (this.closed) return;
        this.disarm(batch);
        if (batch.pending > 0) return;
        const now = Date.now();
        const quietUntil = batch.lastArrivalAt + this.options.quietMs;
        const maxAt = batch.openedAt + this.options.maxWaitMs;
        const delay = Math.max(0, Math.min(quietUntil, maxAt) - now);
        batch.timer = setTimeout(() => this.close(key), delay);
        batch.timer.unref?.();
    }

    private close(key: string): void {
        const batch = this.batches.get(key);
        if (!batch) return;
        this.batches.delete(key);
        this.disarm(batch);
        const previous = this.tails.get(key) ?? Promise.resolve();
        const tail = previous
            .then(() => Promise.allSettled(batch.items))
            .then((settled) => {
                if (this.closed) return;
                const items = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
                if (items.length > 0) this.options.flush(key, items);
            });
        this.tails.set(key, tail);
        void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        });
    }
}

/** One inbound message, downloaded and ready to join its chat's batch. */
export interface PreparedInbound {
    readonly platformMessageId: string;
    readonly channelId: string;
    readonly peerId: string;
    readonly chatId: string;
    readonly text: string;
    readonly media: readonly ChannelMediaRef[] | undefined;
}

/**
 * Submit one chat's batch as a single prompt — wording and pictures in one
 * user turn, so the model sees the picture its caption talks about. The
 * batch's first message names the command, so a redelivery of it still dedups.
 */
export async function submitPreparedBatch(
    ctx: ChannelContext,
    log: Logger,
    items: readonly PreparedInbound[],
): Promise<void> {
    const first = items[0];
    const text = items
        .map((item) => item.text.trim())
        .filter((line) => line !== "")
        .join("\n\n");
    const media = items.flatMap((item) => item.media ?? []);
    try {
        const { sessionId } = await ctx.ingress.submit({
            platformMessageId: first.platformMessageId,
            channelId: first.channelId,
            peerId: first.peerId,
            chatId: first.chatId,
            kind: media.length > 0 ? "media" : "text",
            text,
            ...(media.length > 0 ? { media } : {}),
        });
        // peerId/chatId are platform user identifiers and logs persist to
        // disk — only sessionId is safe to record.
        log.child({ sid: sessionId }).info(
            items.length > 1
                ? `inbound message routed (batch of ${items.length})`
                : "inbound message routed",
        );
    } catch (e) {
        log.error(`inbound submit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
