import type { SdkMessage, SdkUserMessage } from "./claudeCodeSdk.ts";

/** A send is accepted only while the run's input is open; message IDs must be unique. */
export interface ClaudeCodeInputHandle {
    send(prompt: string, messageId: string): boolean;
    close(): void;
}

/** One FIFO shared by the initial prompt and all inputs accepted during the run. */
export class ClaudeCodeInput implements ClaudeCodeInputHandle, AsyncIterable<SdkUserMessage> {
    private readonly queue: SdkUserMessage[] = [];
    private readonly seen = new Set<string>();
    private readonly pending = new Set<string>();
    private wake: (() => void) | undefined;
    private closed = false;
    private uncertainDelivery = false;

    constructor(private readonly onSend: (prompt: string) => void) {}

    send(prompt: string, messageId: string): boolean {
        if (this.closed || this.seen.has(messageId)) return false;
        this.seen.add(messageId);
        this.pending.add(messageId);
        this.queue.push({
            type: "user",
            message: { role: "user", content: prompt },
            parent_tool_use_id: null,
            uuid: messageId,
        });
        this.onSend(prompt);
        this.wake?.();
        return true;
    }

    complete(frame: Extract<SdkMessage, { type: "result" }>): void {
        const ids =
            (frame.user_message_uuids?.length ? frame.user_message_uuids : undefined) ??
            (frame.user_message_uuid ? [frame.user_message_uuid] : undefined);
        if (ids) {
            for (const id of ids) this.pending.delete(id);
        } else {
            if (this.seen.size > 1 && this.pending.size > 0) this.uncertainDelivery = true;
            // A sole input cannot have coalesced with another host input.
            else if (this.seen.size === 1) this.pending.clear();
        }
        // This counts queued sends, not future results. Positive guarantees another turn;
        // zero may also mean discarded backlog, so it cannot acknowledge any message.
        const moreResults = frame.queued_turn_count !== undefined && frame.queued_turn_count > 0;
        if (this.uncertainDelivery && this.pending.size > 0 && !moreResults) {
            this.failUncertainDelivery();
        }
        if (this.pending.size === 0 && !moreResults) {
            this.close();
        }
    }

    finish(): void {
        if (this.uncertainDelivery && this.pending.size > 0) this.failUncertainDelivery();
    }

    private failUncertainDelivery(): never {
        this.queue.length = 0;
        this.close();
        throw new Error(
            "Claude Code input delivery is uncertain: the CLI returned no message UUIDs for multiple accepted inputs. " +
                "Queued sends may have coalesced or been discarded; queued_turn_count cannot confirm their completion. " +
                "The run was stopped without confirming delivery. Do not automatically resend; inspect the saved transcript before resuming.",
        );
    }

    close(): void {
        this.closed = true;
        this.wake?.();
    }

    async *[Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
        while (true) {
            const next = this.queue.shift();
            if (next) yield next;
            else if (this.closed) return;
            else
                await new Promise<void>((resolve) => {
                    this.wake = resolve;
                });
        }
    }
}
