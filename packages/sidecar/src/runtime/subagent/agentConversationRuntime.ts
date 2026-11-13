import { type AgentSessionDescriptor, asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentChatArgs, AgentChatResult } from "../../agents/agentConversationTypes.ts";
import type { AgentDefinition, SubagentRuntime } from "../../agents/types.ts";
import { createLogger } from "../../lib/logger.ts";
import { textBlocks } from "../../lib/textBlocks.ts";
import { findBalancedTagsSkippingFences } from "../../tags/fenceAware.ts";
import type { AgentMessage } from "../pi/types.ts";
import { readSessionFacts } from "../session/sessionFacts.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import {
    AgentConversation,
    type AgentMessageRecord,
    agentMessageEnvelope,
} from "./agentConversation.ts";
import { readAgentMessages, writeAgentMessages } from "./agentMessages.ts";
import { readCodexState } from "./codex/codexState.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";

const log = createLogger("sidecar.agentConversation");

export interface AgentExecutionState {
    runId: string;
    parentSessionId: SessionId;
    runtime?: SubagentRuntime;
    phase: "preparing" | "running" | "settling";
    input?: { send(prompt: string, messageId: string): boolean; close(): void };
}

export interface AgentConversationRuntimeOptions {
    registry: SessionRegistry;
    findAgent(name: string): AgentDefinition | undefined;
    start(
        message: AgentMessageRecord,
        args: AgentChatArgs,
    ): Promise<{
        result: AgentChatResult;
        completion?: Promise<AgentChatResult>;
    }>;
}

interface TrackedAgentExecution extends AgentExecutionState {
    consumedMessages: Set<string>;
    cancelledMessages: Set<string>;
    settled: Promise<void>;
    resolveSettled(): void;
}

function envelopeId(message: AgentMessage): string | undefined {
    if (message.role !== "user") return undefined;
    const text = (
        typeof message.content === "string"
            ? message.content
            : textBlocks(message.content).join("\n")
    ).trim();
    const tags = findBalancedTagsSkippingFences(text, "agent_message");
    const tag = tags[0];
    return tags.length === 1 && tag?.range[0] === 0 && tag.range[1] === text.length
        ? tag.attrs.id
        : undefined;
}

/** Coordinates native lane queues with the lifetime of a delegated execution. */
export class AgentConversationRuntime {
    readonly messages: AgentConversation;
    private readonly executions = new Map<SessionId, TrackedAgentExecution>();
    private readonly flushing = new Set<SessionId>();
    private readonly dirty = new Set<SessionId>();
    private readonly dispatches = new Set<Promise<void>>();
    private disposed = false;

    constructor(private readonly options: AgentConversationRuntimeOptions) {
        const registry = options.registry;
        this.messages = new AgentConversation({
            readFacts: (id) => registry.withSession(id, readSessionFacts),
            readMessages: (id) => registry.withSession(id, readAgentMessages),
            writeMessages: (id, records) =>
                registry.withSession(id, (session) => writeAgentMessages(session, records)),
            isRunning: (id) => this.executions.has(id),
            deliver: (message, args) => this.deliver(message, args),
        });
        registry.on("session.event", this.onEvent);
        registry.on("session.idle", this.onIdle);
        registry.on("session.attached", this.onAttached);
    }

    private readonly onEvent = ({
        sessionId,
        event,
    }: {
        sessionId: SessionId;
        event: {
            type: string;
            message?: AgentMessage;
            steer?: AgentMessage[];
            followUp?: AgentMessage[];
        };
    }): void => {
        const execution = this.executions.get(sessionId);
        if (event.type === "run_start") {
            if (execution) execution.phase = "running";
            this.wake(sessionId);
        } else if (execution && event.type === "message_end" && event.message) {
            const id = envelopeId(event.message);
            if (id) execution.consumedMessages.add(id);
        } else if (execution && event.type === "operation_abort") {
            for (const message of [...(event.steer ?? []), ...(event.followUp ?? [])]) {
                const id = envelopeId(message);
                if (id) execution.cancelledMessages.add(id);
            }
        }
    };

    private readonly onIdle = ({ sessionId }: { sessionId: SessionId }): void => {
        this.wake(sessionId);
    };
    private readonly onAttached = ({ sessionId }: { sessionId: SessionId }): void => {
        this.wake(sessionId);
        // Parent attach is also the recovery point for messages to detached children.
        void this.list(sessionId)
            .then((children) => {
                for (const child of children) this.wake(child.subSessionId);
            })
            .catch((error: unknown) =>
                log.debug("agent discovery unavailable on attach", { error: String(error) }),
            );
    };

    begin(id: SessionId, state: AgentExecutionState): void {
        if (this.disposed) throw new Error("Agent communication is shutting down.");
        if (this.executions.has(id))
            throw new Error("This agent already has an admitted execution.");
        let resolveSettled = () => {};
        const settled = new Promise<void>((resolve) => {
            resolveSettled = resolve;
        });
        this.executions.set(id, {
            ...state,
            consumedMessages: new Set(),
            cancelledMessages: new Set(),
            settled,
            resolveSettled,
        });
    }

    state(id: SessionId): AgentExecutionState | undefined {
        return this.executions.get(id);
    }

    settling(id: SessionId): void {
        const execution = this.executions.get(id);
        if (execution) execution.phase = "settling";
    }

    markRunning(id: SessionId, runId?: string): void {
        const execution = this.executions.get(id);
        if (!execution) return;
        if (runId !== undefined && execution.runId !== runId) return;
        execution.phase = "running";
    }

    setInput(id: SessionId, input: NonNullable<AgentExecutionState["input"]>): void {
        const execution = this.executions.get(id);
        if (!execution) {
            input.close();
            return;
        }
        execution.input = input;
        execution.phase = "running";
        this.wake(id);
    }

    async end(id: SessionId, runId: string, result?: SubagentRunResult): Promise<void> {
        const execution = this.executions.get(id);
        if (execution?.runId !== runId) return;
        try {
            // Inspect before admission drains, then refresh inside it: an enqueue may be in flight.
            await this.nativeQueuedIds(id).catch((error: unknown) => {
                log.warn("failed to inspect native queue before settling", {
                    id,
                    error: String(error),
                });
            });
            await this.messages
                .update(id, async (records) => {
                    let queued = new Set<string>();
                    try {
                        queued = await this.nativeQueuedIds(id);
                    } catch (error) {
                        log.warn("failed to inspect native queue while settling", {
                            id,
                            error: String(error),
                        });
                    }
                    for (const record of records) {
                        const receipt = record.receipt;
                        const consumed = execution.consumedMessages.has(record.messageId);
                        const cancelled = execution.cancelledMessages.has(record.messageId);
                        const belongsToRun =
                            consumed ||
                            cancelled ||
                            receipt?.runId === runId ||
                            record.queuedDuringRunId === runId;
                        if (!belongsToRun || !receipt) continue;
                        if (result?.aborted || cancelled) {
                            record.receipt = {
                                ...receipt,
                                status: "aborted",
                                resultText:
                                    "The run was stopped; this message may not have been consumed.",
                                isError: false,
                            };
                            record.queuedDuringRunId = undefined;
                        } else if (record.queuedDuringRunId === runId) {
                            record.queuedDuringRunId = undefined;
                        } else if (record.queueEntryId && queued.has(record.queueEntryId)) {
                            record.receipt = { ...receipt, runId: undefined, status: "queued" };
                        } else if (!record.queueEntryId && receipt.status === "queued") {
                            record.receipt = { ...receipt, runId: undefined };
                        } else if (
                            record.queueEntryId &&
                            !record.queueEntryId.startsWith("claude:") &&
                            !consumed
                        ) {
                            record.receipt = {
                                ...receipt,
                                status: "error",
                                isError: true,
                                resultText:
                                    "Delivery could not be confirmed; the queue entry disappeared without a consumed-message event. It was not automatically resent.",
                            };
                        } else {
                            record.receipt = {
                                ...receipt,
                                runId,
                                status: result?.isError ? "error" : "completed",
                                resultText: result?.resultText ?? "The execution settled.",
                                isError: result?.isError ?? false,
                            };
                        }
                    }
                })
                .catch((error: unknown) =>
                    log.error("failed to settle message receipts", { id, error: String(error) }),
                );
        } finally {
            if (this.executions.get(id)?.runId === runId) this.executions.delete(id);
            execution.resolveSettled();
            this.wake(id);
        }
    }

    chat(caller: SessionId, args: AgentChatArgs): Promise<AgentChatResult> {
        if (this.disposed)
            return Promise.reject(new Error("Agent communication is shutting down."));
        return this.messages.chat(caller, args);
    }

    async list(caller: SessionId): Promise<AgentSessionDescriptor[]> {
        const registry = this.options.registry;
        const callerFacts = await registry.withSession(caller, readSessionFacts);
        const parent = callerFacts.kind === "subagent" ? callerFacts.parentSessionId : caller;
        if (!parent) return [];
        const out: AgentSessionDescriptor[] = [];
        for (const meta of await registry.listSessions()) {
            if (meta.id === caller) continue;
            const id = asSessionId(meta.id);
            const facts = await registry.getSessionFacts(id);
            if (facts.kind !== "subagent" || facts.parentSessionId !== parent) continue;
            const def = facts.agentType ? this.options.findAgent(facts.agentType) : undefined;
            const canResume =
                def !== undefined &&
                (def.runtime ?? "standard") === (facts.runtime ?? "standard") &&
                (facts.runtime !== "codex" ||
                    (await registry.withSession(id, readCodexState)) !== undefined);
            out.push({
                subSessionId: id,
                agentType: facts.agentType ?? "unknown",
                description: def?.description,
                status: this.executions.get(id)?.phase ?? "idle",
                canResume,
                delivery:
                    facts.runtime === "claude-code"
                        ? "nextTurn"
                        : facts.runtime === "codex"
                          ? "queued"
                          : ("steer" as const),
            });
            if (out.length === 64) break;
        }
        return out;
    }

    private async deliver(message: AgentMessageRecord, args: AgentChatArgs) {
        if (this.disposed) throw new Error("Agent communication is shutting down.");
        const state = this.executions.get(message.targetSessionId);
        if (!state) return this.options.start(message, args);
        if (state.runtime === "codex") {
            message.queuedDuringRunId = state.runId;
            return { result: this.receipt(message, "queued", undefined, "queued") };
        }
        const received = state.phase === "running" ? await this.enqueue(message, state) : undefined;
        if (received) return { result: received };
        return {
            result: this.receipt(
                message,
                "queued",
                state.phase === "settling" ? undefined : state.runId,
            ),
        };
    }

    private receipt(
        message: AgentMessageRecord,
        status: "queued" | "started",
        runId?: string,
        effectiveDelivery?: AgentChatResult["effectiveDelivery"],
    ): AgentChatResult {
        return {
            subSessionId: message.targetSessionId,
            messageId: message.messageId,
            status,
            effectiveDelivery: effectiveDelivery ?? message.delivery,
            ...(runId !== undefined ? { runId } : {}),
            resultText: "Message accepted. This is a delivery receipt, not a task result.",
            isError: false,
        };
    }

    private async enqueue(
        message: AgentMessageRecord,
        state: AgentExecutionState,
    ): Promise<AgentChatResult | undefined> {
        if (state.input) {
            if (!state.input.send(agentMessageEnvelope(message), message.messageId))
                return undefined;
            message.queueEntryId = `claude:${message.messageId}`;
            message.receipt = {
                ...this.receipt(message, "queued", state.runId),
                effectiveDelivery: "nextTurn",
            };
            return message.receipt;
        }
        const attached = this.options.registry.getAttached(message.targetSessionId);
        if (!attached) return undefined;
        const queued = await attached.enqueue(message.delivery, agentMessageEnvelope(message));
        if (queued.mode === "idle") return undefined;
        message.queueEntryId = queued.entryId;
        message.receipt = this.receipt(message, "queued", state.runId);
        return message.receipt;
    }

    private async nativeQueuedIds(id: SessionId): Promise<Set<string>> {
        const attached = this.options.registry.getAttached(id);
        if (!attached?.watchSnapshot) return new Set();
        const watch = await attached.watchSnapshot();
        try {
            return new Set(watch.snapshot.queues.map((entry) => entry.entryId));
        } finally {
            watch.unsubscribe();
        }
    }

    private wake(id: SessionId): void {
        if (this.disposed) return;
        this.dirty.add(id);
        if (this.flushing.has(id)) return;
        this.flushing.add(id);
        const dispatch = this.flush(id)
            .catch((error: unknown) => {
                log.error("agent message dispatch failed", { id, error: String(error) });
            })
            .finally(() => {
                this.flushing.delete(id);
                this.dispatches.delete(dispatch);
                if (this.dirty.has(id)) this.wake(id);
            });
        this.dispatches.add(dispatch);
    }

    private async flush(id: SessionId): Promise<void> {
        this.dirty.delete(id);
        const facts = await this.options.registry.withSession(id, readSessionFacts);
        if (facts.kind !== "subagent") return;
        await this.messages.update(id, async (records) => {
            for (const pending of records) {
                if (this.disposed) return;
                if (pending.receipt?.status !== "queued") continue;
                const state = this.executions.get(id);
                if (state?.phase === "preparing" || state?.phase === "settling") return;
                if (state && pending.queueEntryId && state.runId === pending.receipt.runId)
                    continue;
                if (state) {
                    if (!pending.queueEntryId) await this.enqueue(pending, state);
                    continue;
                }
                const attached = this.options.registry.getAttached(id);
                if (attached && (await attached.getExecutionState()) === "running") return;
                if (pending.receipt.runId) {
                    const queued = await this.nativeQueuedIds(id);
                    if (!pending.queueEntryId || !queued.has(pending.queueEntryId)) {
                        pending.receipt = {
                            ...pending.receipt,
                            status: "error",
                            isError: true,
                            resultText:
                                "Delivery is uncertain after a process restart: the previous run may already have consumed this message. It was not automatically resent.",
                        };
                        continue;
                    }
                }
                const result = await this.options.start(
                    { ...pending, background: true },
                    {
                        parentToolCallId: `message:${pending.messageId}`,
                        subSessionId: id,
                        prompt: pending.prompt,
                        background: true,
                    },
                );
                pending.receipt = result.result;
                break;
            }
        });
    }

    stopAccepting(): void {
        this.disposed = true;
        this.dirty.clear();
    }

    async whenExecutionsSettle(): Promise<void> {
        await Promise.all([...this.executions.values()].map((execution) => execution.settled));
    }

    async dispose(): Promise<void> {
        this.stopAccepting();
        this.options.registry.off("session.event", this.onEvent);
        this.options.registry.off("session.idle", this.onIdle);
        this.options.registry.off("session.attached", this.onAttached);
        for (const state of this.executions.values()) state.input?.close();
        this.executions.clear();
        this.dirty.clear();
        await Promise.allSettled([...this.dispatches]);
    }
}
