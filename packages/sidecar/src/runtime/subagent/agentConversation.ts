import { asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentChatArgs, AgentChatResult } from "../../agents/agentConversationTypes.ts";
import { tagWrap } from "../../tags/builder.ts";
import { uuidv7 } from "../pi/values.ts";
import type { SessionFacts } from "../session/sessionFacts.ts";
import { neutralizeControlTags } from "./subagentProgress.ts";

export interface AgentMessageRecord {
    messageId: string;
    invocationId: string;
    senderSessionId: SessionId;
    targetSessionId: SessionId;
    ownerParentSessionId: SessionId;
    relation: "parent" | "peer";
    prompt: string;
    delivery: "steer" | "followUp";
    background: boolean;
    inReplyTo?: string;
    createdAt: number;
    receipt?: AgentChatResult;
    queueEntryId?: string;
    /** Internal association only; public receipts still omit runId while queued. */
    queuedDuringRunId?: string;
}

export interface AgentConversationDeps {
    readFacts(id: SessionId): Promise<SessionFacts>;
    readMessages(id: SessionId): Promise<AgentMessageRecord[]>;
    writeMessages(id: SessionId, messages: AgentMessageRecord[]): Promise<void>;
    isRunning(id: SessionId): boolean;
    deliver(
        message: AgentMessageRecord,
        args: AgentChatArgs,
    ): Promise<{
        result: AgentChatResult;
        completion?: Promise<AgentChatResult>;
    }>;
}

/** Admission is serialized, but never holds the queue while a model is running. */
export class AgentConversation {
    private readonly admissions = new Map<SessionId, Promise<void>>();

    constructor(private readonly deps: AgentConversationDeps) {}

    async authorize(
        caller: SessionId,
        target: SessionId,
    ): Promise<{
        facts: SessionFacts;
        ownerParentSessionId: SessionId;
        relation: "parent" | "peer";
    }> {
        if (caller === target) throw new Error("An agent cannot send a message to itself.");
        const [callerFacts, facts] = await Promise.all([
            this.deps.readFacts(caller),
            this.deps.readFacts(target),
        ]);
        if (facts.kind !== "subagent" || !facts.parentSessionId) {
            throw new Error("The target is not a child agent session.");
        }
        const relation = facts.parentSessionId === caller ? "parent" : "peer";
        if (
            relation === "peer" &&
            (callerFacts.kind !== "subagent" ||
                callerFacts.parentSessionId !== facts.parentSessionId)
        ) {
            throw new Error("The target belongs to a different parent session.");
        }
        return { facts, ownerParentSessionId: asSessionId(facts.parentSessionId), relation };
    }

    async chat(caller: SessionId, args: AgentChatArgs): Promise<AgentChatResult> {
        const messageId = uuidv7();
        const fail = (error: unknown): AgentChatResult => ({
            subSessionId: args.subSessionId,
            messageId,
            status: "error",
            effectiveDelivery: args.delivery ?? "steer",
            resultText: error instanceof Error ? error.message : String(error),
            isError: true,
        });
        try {
            args.signal?.throwIfAborted();
            if (!args.prompt.trim()) throw new Error("An agent message must not be empty.");
            if (args.prompt.length > 64_000)
                throw new Error("Agent messages are limited to 64000 characters.");
            // Every invocation is authorized before it may read an existing receipt.
            const authorized = await this.authorize(caller, args.subSessionId);
            const admitted = await this.serial(args.subSessionId, async () => {
                args.signal?.throwIfAborted();
                const records = await this.deps.readMessages(args.subSessionId);
                const invocationId = JSON.stringify([caller, args.parentToolCallId]);
                const previous = records.find((record) => record.invocationId === invocationId);
                if (previous) {
                    if (previous.prompt !== args.prompt || previous.inReplyTo !== args.inReplyTo) {
                        throw new Error("This invocation already sent a different agent message.");
                    }
                    if (previous.receipt) return { result: previous.receipt };
                    throw new Error(
                        "Agent message delivery is uncertain after an interrupted admission; do not automatically resend it.",
                    );
                }
                const background = args.background ?? true;
                if (
                    !background &&
                    (authorized.relation !== "parent" || this.deps.isRunning(args.subSessionId))
                ) {
                    throw new Error(
                        "Blocking chat is only available for an idle own child. Use background: true for running agents and peers.",
                    );
                }
                if (args.inReplyTo) {
                    const received = await this.deps.readMessages(caller);
                    if (
                        !received.some(
                            (record) =>
                                record.messageId === args.inReplyTo &&
                                record.senderSessionId === args.subSessionId,
                        )
                    ) {
                        throw new Error(
                            "inReplyTo must reference a message received from the target agent.",
                        );
                    }
                }
                if (
                    records.filter(
                        (record) => !record.receipt || record.receipt.status === "queued",
                    ).length >= 32
                ) {
                    throw new Error(
                        "This agent's message inbox is full. Wait for its current work to finish.",
                    );
                }
                const message: AgentMessageRecord = {
                    messageId,
                    invocationId,
                    senderSessionId: caller,
                    targetSessionId: args.subSessionId,
                    ownerParentSessionId: authorized.ownerParentSessionId,
                    relation: authorized.relation,
                    prompt: args.prompt,
                    delivery: args.delivery ?? "steer",
                    background,
                    inReplyTo: args.inReplyTo,
                    createdAt: Date.now(),
                };
                // Store intent before crossing into an engine. A crash must not look unsent.
                const next = [...records.slice(-127), message];
                await this.deps.writeMessages(args.subSessionId, next);
                const delivered = await this.deps.deliver(message, args);
                message.receipt = delivered.result;
                await this.deps.writeMessages(args.subSessionId, next);
                return delivered;
            });
            return admitted.completion ? await admitted.completion : admitted.result;
        } catch (error) {
            return fail(error);
        }
    }

    async update(
        id: SessionId,
        update: (records: AgentMessageRecord[]) => void | Promise<void>,
    ): Promise<void> {
        await this.serial(id, async () => {
            const records = await this.deps.readMessages(id);
            await update(records);
            await this.deps.writeMessages(id, records);
        });
    }

    private async serial<T>(id: SessionId, action: () => Promise<T>): Promise<T> {
        const previous = this.admissions.get(id) ?? Promise.resolve();
        const result = previous.then(action);
        const settled = result.then(
            () => undefined,
            () => undefined,
        );
        this.admissions.set(id, settled);
        try {
            return await result;
        } finally {
            if (this.admissions.get(id) === settled) this.admissions.delete(id);
        }
    }
}

export function agentMessageEnvelope(message: AgentMessageRecord): string {
    return tagWrap("agent_message", neutralizeControlTags(message.prompt).text, {
        id: message.messageId,
        from: message.senderSessionId,
        relation: message.relation,
        ...(message.inReplyTo ? { "in-reply-to": message.inReplyTo } : {}),
    });
}
