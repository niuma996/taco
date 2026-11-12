import { type AgentSessionDescriptor, asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentChatArgs, AgentChatResult } from "../../agents/agentConversationTypes.ts";
import type { AgentDefinition } from "../../agents/types.ts";
import { createLogger } from "../../lib/logger.ts";
import { readSessionFacts } from "../session/sessionFacts.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import {
    AgentConversation,
    type AgentMessageRecord,
    agentMessageEnvelope,
} from "./agentConversation.ts";
import { readAgentMessages, writeAgentMessages } from "./agentMessages.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";

const log = createLogger("sidecar.agentConversation");

export interface AgentExecutionState {
    runId: string;
    parentSessionId: SessionId;
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

/** Coordinates native lane queues with the lifetime of a delegated execution. */
export class AgentConversationRuntime {
    readonly messages: AgentConversation;
    private readonly executions = new Map<SessionId, AgentExecutionState>();
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
        event: { type: string };
    }): void => {
        if (event.type !== "run_start") return;
        const execution = this.executions.get(sessionId);
        if (execution) execution.phase = "running";
        this.wake(sessionId);
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
        if (this.executions.has(id))
            throw new Error("This agent already has an admitted execution.");
        this.executions.set(id, state);
    }

    state(id: SessionId): AgentExecutionState | undefined {
        return this.executions.get(id);
    }

    settling(id: SessionId): void {
        const execution = this.executions.get(id);
        if (execution) execution.phase = "settling";
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
        if (this.executions.get(id)?.runId !== runId) return;
        // Inspect before admission drains, then refresh inside it: an enqueue may be in flight.
        await this.nativeQueuedIds(id);
        await this.messages
            .update(id, async (records) => {
                const queued = await this.nativeQueuedIds(id);
                for (const record of records) {
                    if (record.receipt?.runId !== runId) continue;
                    if (result?.aborted) {
                        record.receipt = {
                            ...record.receipt,
                            status: "aborted",
                            resultText:
                                "The run was stopped; this message may not have been consumed.",
                            isError: false,
                        };
                    } else if (record.queueEntryId && queued.has(record.queueEntryId)) {
                        record.receipt = { ...record.receipt, runId: undefined, status: "queued" };
                    } else if (!record.queueEntryId && record.receipt.status === "queued") {
                        record.receipt.runId = undefined;
                    } else {
                        record.receipt = {
                            ...record.receipt,
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
        if (this.executions.get(id)?.runId === runId) this.executions.delete(id);
        this.wake(id);
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
            out.push({
                subSessionId: id,
                agentType: facts.agentType ?? "unknown",
                description: def?.description,
                status: this.executions.get(id)?.phase ?? "idle",
                canResume:
                    def !== undefined &&
                    (def.runtime ?? "standard") === (facts.runtime ?? "standard"),
                delivery: facts.runtime === "claude-code" ? "nextTurn" : "steer",
            });
            if (out.length === 64) break;
        }
        return out;
    }

    private async deliver(message: AgentMessageRecord, args: AgentChatArgs) {
        const state = this.executions.get(message.targetSessionId);
        if (!state) return this.options.start(message, args);
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
    ): AgentChatResult {
        return {
            subSessionId: message.targetSessionId,
            messageId: message.messageId,
            status,
            effectiveDelivery: message.delivery,
            runId,
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

    async dispose(): Promise<void> {
        this.disposed = true;
        this.options.registry.off("session.event", this.onEvent);
        this.options.registry.off("session.idle", this.onIdle);
        this.options.registry.off("session.attached", this.onAttached);
        for (const state of this.executions.values()) state.input?.close();
        this.executions.clear();
        this.dirty.clear();
        await Promise.allSettled([...this.dispatches]);
    }
}
