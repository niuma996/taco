import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, type TestContext } from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentChatArgs, AgentChatResult } from "../../src/agents/agentConversationTypes.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import type { QueueKind, SteerEnqueueResult } from "../../src/runtime/harness/laneQueue.ts";
import type { Session } from "../../src/runtime/pi/types.ts";
import { writeSessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import type { SessionRegistry } from "../../src/runtime/session/sessionRegistry.ts";
import {
    type AgentMessageRecord,
    agentMessageEnvelope,
} from "../../src/runtime/subagent/agentConversation.ts";
import { AgentConversationRuntime } from "../../src/runtime/subagent/agentConversationRuntime.ts";
import { readAgentMessages, writeAgentMessages } from "../../src/runtime/subagent/agentMessages.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

const parent = asSessionId("parent");
const child = asSessionId("child");

class NativeQueue {
    running = false;
    readonly entries: { entryId: string; kind: QueueKind; text: string }[] = [];
    readonly enqueues: { kind: QueueKind; text: string }[] = [];
    beforeCommit?: () => Promise<void>;
    onSnapshot?: () => void;

    async enqueue(kind: QueueKind, text: string): Promise<SteerEnqueueResult> {
        this.enqueues.push({ kind, text });
        if (!this.running) return { mode: "idle" };
        // Match enqueueLaneMessage's inspect-then-write window: the run can
        // finish after inspection while the native write still succeeds.
        await this.beforeCommit?.();
        const entryId = `native-${this.enqueues.length}`;
        this.entries.push({ entryId, kind, text });
        return { mode: "queued", entryId };
    }

    async watchSnapshot() {
        const snapshot = { queues: this.entries.map(({ entryId }) => ({ entryId })) };
        this.onSnapshot?.();
        return { snapshot, unsubscribe() {} };
    }

    async getExecutionState(): Promise<"running" | "idle"> {
        return this.running ? "running" : "idle";
    }
}

/** Keep real JSONL reads/writes, controlling only native queue and lifecycle events. */
class RuntimeRegistry extends EventEmitter {
    private readonly pending = new Set<Promise<unknown>>();

    constructor(
        private readonly persisted: SessionRegistry,
        readonly native: NativeQueue,
    ) {
        super();
    }

    withSession<T>(id: SessionId, action: (session: Session) => Promise<T>): Promise<T> {
        const operation = this.persisted.withSession(id, action);
        this.pending.add(operation);
        void operation.then(
            () => this.pending.delete(operation),
            () => this.pending.delete(operation),
        );
        return operation;
    }

    getAttached(id: SessionId): NativeQueue | undefined {
        return id === child ? this.native : undefined;
    }

    listSessions() {
        return this.persisted.listSessions();
    }

    getSessionFacts(id: SessionId) {
        return this.persisted.getSessionFacts(id);
    }

    async drain(): Promise<void> {
        // A flush alternates disk I/O and serialized admission work. Let each
        // continuation schedule its next read/write before checking quiescence.
        do {
            await Promise.allSettled([...this.pending]);
            await nextImmediate();
        } while (this.pending.size > 0);
    }
}

async function fixture(t: TestContext, phase: "preparing" | "running" = "running") {
    const workspace = createTestWorkspace({ prefix: "conversation-runtime" });
    const runtimes: AgentConversationRuntime[] = [];
    t.after(async () => {
        try {
            await Promise.all(runtimes.map((runtime) => runtime.dispose()));
        } finally {
            await workspace.cleanup();
        }
    });
    for (const id of [parent, child]) {
        const session = await workspace.ws.repo.create(
            { id, cwd: workspace.cwd, ...(id === child ? { parentSessionId: parent } : {}) },
            harnessContext,
        );
        try {
            await writeSessionFacts(
                session,
                id === child
                    ? { kind: "subagent", parentSessionId: parent, agentType: "explorer", depth: 1 }
                    : { kind: "main", depth: 0 },
            );
        } finally {
            await session.close(harnessContext);
        }
    }
    workspace.ws.sessionRegistry.invalidateListCache();
    const native = new NativeQueue();
    const registry = new RuntimeRegistry(workspace.ws.sessionRegistry, native);
    const starts: { message: AgentMessageRecord; args: AgentChatArgs }[] = [];
    const runtime = new AgentConversationRuntime({
        // SessionRegistry is nominal; this facade retains real persistence
        // while exposing just the event/queue boundary under test.
        registry: registry as unknown as SessionRegistry,
        findAgent: () => undefined,
        async start(message, args) {
            starts.push({ message: structuredClone(message), args });
            const runId = `resumed-${starts.length}`;
            runtime.begin(child, { runId, parentSessionId: parent, phase: "preparing" });
            const result: AgentChatResult = {
                subSessionId: child,
                messageId: message.messageId,
                status: "started",
                effectiveDelivery: message.delivery,
                runId,
                resultText: "Accepted",
                isError: false,
            };
            return { result };
        },
    });
    runtimes.push(runtime);
    runtime.begin(child, { runId: "initial-run", parentSessionId: parent, phase });
    native.running = phase === "running";
    const send = (call: string, prompt: string, extra: Partial<AgentChatArgs> = {}) =>
        runtime.chat(parent, {
            parentToolCallId: call,
            subSessionId: child,
            prompt,
            background: true,
            ...extra,
        });
    const records = () => registry.withSession(child, readAgentMessages);
    const runStart = () => {
        native.running = true;
        registry.emit("session.event", { sessionId: child, event: { type: "run_start" } });
    };
    const completed = { subSessionId: child, resultText: "Finished", isError: false };
    return { runtime, runtimes, registry, native, starts, send, records, runStart, completed };
}

function recoveredMessage(
    overrides: Partial<AgentMessageRecord> & {
        receipt: NonNullable<AgentMessageRecord["receipt"]>;
    },
): AgentMessageRecord {
    return {
        messageId: "recovered-message",
        invocationId: JSON.stringify([parent, "recovered-call"]),
        senderSessionId: parent,
        targetSessionId: child,
        ownerParentSessionId: parent,
        relation: "parent",
        prompt: "RECOVERED_MESSAGE_BODY",
        delivery: "followUp",
        background: true,
        createdAt: Date.now(),
        ...overrides,
    };
}

describe("AgentConversationRuntime", { timeout: 5_000 }, () => {
    it("enqueues two distinct messages separately in a running agent and persists both receipts", async (t) => {
        const f = await fixture(t);
        const [first, second] = await Promise.all([
            f.send("call-1", "First instruction"),
            f.send("call-2", "Second instruction", { delivery: "followUp" }),
        ]);
        assert.equal(first.isError, false);
        assert.equal(second.isError, false);
        assert.notEqual(first.messageId, second.messageId);
        assert.deepEqual(
            f.native.entries.map((entry) => entry.kind),
            ["steer", "followUp"],
        );
        const records = await f.records();
        assert.equal(records.length, 2);
        for (const [index, receipt] of [first, second].entries()) {
            const queued = f.native.entries[index];
            assert.ok(queued);
            assert.ok(queued.text.includes(receipt.messageId));
            assert.ok(
                queued.text.includes(index === 0 ? "First instruction" : "Second instruction"),
            );
            assert.equal(receipt.status, "queued");
            assert.equal(receipt.runId, "initial-run");
            assert.equal(records[index]?.queueEntryId, queued.entryId);
            assert.deepEqual(records[index]?.receipt, receipt);
        }
        assert.equal(f.starts.length, 0, "running messages must not launch another execution");
    });

    it("queues Codex messages in Taco without a run id or native delivery claim", async (t) => {
        const f = await fixture(t);
        const state = f.runtime.state(child);
        assert.ok(state);
        state.runtime = "codex";
        const receipt = await f.send("codex-call", "Apply this after the current turn", {
            delivery: "steer",
        });
        assert.equal(receipt.status, "queued");
        assert.equal(receipt.effectiveDelivery, "queued");
        assert.equal(receipt.runId, undefined);
        assert.equal(f.native.enqueues.length, 0);
        const persisted = (await f.records())[0];
        assert.deepEqual(persisted?.receipt, receipt);
        f.native.running = false;
        await f.runtime.end(child, "initial-run", f.completed);
        await f.registry.drain();
        assert.equal(f.starts.length, 1, "the queued Codex message must wake one later run");
        assert.equal(f.starts[0]?.message.messageId, receipt.messageId);
    });

    it("settles Codex inbox messages on abort instead of starting them later", async (t) => {
        const f = await fixture(t);
        const state = f.runtime.state(child);
        assert.ok(state);
        state.runtime = "codex";
        const receipt = await f.send("codex-abort-call", "Do not run after stop");
        f.native.running = false;
        await f.runtime.end(child, "initial-run", { ...f.completed, aborted: true });
        f.registry.emit("session.idle", { sessionId: child });
        await f.registry.drain();
        const persisted = (await f.records())[0];
        assert.equal(persisted?.receipt?.messageId, receipt.messageId);
        assert.equal(persisted?.receipt?.status, "aborted");
        assert.equal(persisted?.queuedDuringRunId, undefined);
        assert.equal(f.starts.length, 0);
    });

    it("accepts during preparing and delivers exactly once when run_start arrives", async (t) => {
        const f = await fixture(t, "preparing");
        const receipt = await f.send("preparing-call", "Deliver after attachment");
        assert.equal(receipt.status, "queued");
        assert.equal(receipt.isError, false);
        assert.equal(f.native.enqueues.length, 0);
        assert.equal((await f.records())[0]?.queueEntryId, undefined);
        f.runStart();
        await f.registry.drain();
        assert.equal(f.native.entries.length, 1);
        assert.ok(f.native.entries[0]?.text.includes(receipt.messageId));
        assert.equal((await f.records())[0]?.queueEntryId, f.native.entries[0]?.entryId);
        f.runStart();
        await f.registry.drain();
        assert.equal(f.native.enqueues.length, 1, "duplicate run_start must not duplicate input");
        assert.equal(f.starts.length, 0);
    });

    it("wakes a new run for an unconsumed native entry when the current run ends", async (t) => {
        const f = await fixture(t);
        const receipt = await f.send("late-call", "Still needs an answer");
        const entryId = f.native.entries[0]?.entryId;
        f.native.running = false;
        await f.runtime.end(child, "initial-run", f.completed);
        await f.registry.drain();
        assert.equal(f.starts.length, 1, "unconsumed native input must wake a new run");
        assert.equal(f.starts[0]?.message.messageId, receipt.messageId);
        assert.equal(f.starts[0]?.message.queueEntryId, entryId);
        assert.equal(f.starts[0]?.message.background, true);
        assert.equal((await f.records())[0]?.receipt?.runId, "resumed-1");
        f.runStart();
        f.registry.emit("session.idle", { sessionId: child });
        await f.registry.drain();
        assert.equal(f.starts.length, 1);
        assert.equal(
            f.native.enqueues.length,
            1,
            "the retained native entry must not be enqueued twice",
        );
    });

    it("wakes a new run when settlement snapshots the native queue before an in-flight enqueue commits", async (t) => {
        const f = await fixture(t);
        const snapshotTaken = new Promise<void>((resolve) => {
            f.native.onSnapshot = resolve;
        });
        let ending: Promise<void> | undefined;
        f.native.beforeCommit = async () => {
            f.native.running = false;
            ending = f.runtime.end(child, "initial-run", f.completed);
            await snapshotTaken;
        };
        const receipt = await f.send("racing-call", "Arrives at the end of the run");
        assert.equal(receipt.isError, false);
        assert.ok(ending, "the run must have ended inside the enqueue window");
        await ending;
        await f.registry.drain();
        assert.equal(
            f.native.entries.length,
            1,
            "the native write succeeded after the run stopped",
        );
        assert.equal(
            f.starts.length,
            1,
            "accepted but unconsumed input must not be stranded after a stale snapshot",
        );
        const persisted = (await f.records())[0];
        assert.equal(persisted?.receipt?.status, "started");
        assert.equal(persisted?.receipt?.runId, "resumed-1");
        assert.equal(f.starts[0]?.message.messageId, receipt.messageId);
        assert.equal(f.starts[0]?.message.queueEntryId, f.native.entries[0]?.entryId);
    });

    for (const phase of ["running", "preparing"] as const) {
        it(`does not automatically restart unconsumed ${phase} messages after an aborted run`, async (t) => {
            const f = await fixture(t, phase);
            const receipt = await f.send("abort-call", "Do not revive stopped work");
            assert.equal(receipt.isError, false);
            f.native.running = false;
            await f.runtime.end(child, "initial-run", { ...f.completed, aborted: true });
            f.registry.emit("session.idle", { sessionId: child });
            await f.registry.drain();
            const persisted = (await f.records())[0];
            assert.equal(persisted?.receipt?.messageId, receipt.messageId);
            assert.equal(persisted?.receipt?.status, "aborted");
            assert.equal(persisted?.receipt?.isError, false);
            assert.equal(f.runtime.state(child), undefined);
            assert.equal(f.starts.length, 0, "an intentional stop must not restart accepted work");
            assert.equal(f.native.enqueues.length, phase === "running" ? 1 : 0);
        });

        it(`does not cancel accepted ${phase} input or its run when the sender cancels`, async (t) => {
            const f = await fixture(t, phase);
            const sender = new AbortController();
            const receipt = await f.send("sender-call", "Keep working independently", {
                signal: sender.signal,
            });
            assert.equal(receipt.isError, false);
            sender.abort(new Error("Sender turn stopped"));
            f.runStart();
            await f.registry.drain();
            assert.equal(f.runtime.state(child)?.runId, "initial-run");
            assert.equal(f.native.entries.length, 1);
            assert.ok(f.native.entries[0]?.text.includes(receipt.messageId));
            assert.equal((await f.records())[0]?.receipt?.status, "queued");
            // The engine consumes the accepted input and finishes normally
            // after the sender is already cancelled.
            for (const entry of f.native.entries) {
                f.registry.emit("session.event", {
                    sessionId: child,
                    event: { type: "message_end", message: { role: "user", content: entry.text } },
                });
            }
            f.native.entries.length = 0;
            f.native.running = false;
            await f.runtime.end(child, "initial-run", f.completed);
            await f.registry.drain();
            const persisted = (await f.records())[0];
            assert.equal(persisted?.receipt?.status, "completed");
            assert.equal(persisted?.receipt?.isError, false);
            assert.equal(persisted?.receipt?.resultText, "Finished");
            assert.equal(f.starts.length, 0);
        });
    }

    it("releases shutdown waiters if the final native snapshot fails", async (t) => {
        const f = await fixture(t);
        f.runtime.stopAccepting();
        f.native.onSnapshot = () => {
            throw new Error("Snapshot unavailable");
        };
        const draining = f.runtime.whenExecutionsSettle();
        await f.runtime.end(child, "initial-run", { ...f.completed, aborted: true });
        await draining;
        assert.equal(f.runtime.state(child), undefined);
    });

    it("marks a queued run uncertain after restart when its native entry was already consumed", async (t) => {
        const f = await fixture(t);
        await f.runtime.dispose();
        f.native.running = false;
        const message = recoveredMessage({
            queueEntryId: "native-consumed",
            receipt: {
                subSessionId: child,
                messageId: "recovered-message",
                runId: "previous-run",
                status: "queued",
                effectiveDelivery: "followUp",
                resultText: "Message accepted.",
                isError: false,
            },
        });
        await f.registry.withSession(child, (session) => writeAgentMessages(session, [message]));
        const starts: AgentMessageRecord[] = [];
        const restarted = new AgentConversationRuntime({
            registry:
                f.registry as unknown as import("../../src/runtime/session/sessionRegistry.ts").SessionRegistry,
            findAgent: () => undefined,
            async start(started) {
                starts.push(started);
                const receipt = started.receipt;
                assert.ok(receipt);
                return {
                    result: {
                        ...receipt,
                        status: "started",
                        runId: "unexpected-restart",
                        resultText: "restarted",
                        isError: false,
                    },
                };
            },
        });
        f.runtimes.push(restarted);
        f.registry.emit("session.attached", { sessionId: parent });
        await f.registry.drain();
        assert.equal(
            starts.length,
            0,
            "a consumed native entry must never be resent after restart",
        );
        const persisted = (await f.records())[0];
        assert.equal(persisted?.receipt?.status, "error");
        assert.equal(persisted?.receipt?.isError, true);
        assert.match(persisted?.receipt?.resultText ?? "", /uncertain/i);
        assert.equal(restarted.state(child), undefined);
    });

    it("restarts only when a queued run still has a confirmed native entry, while claude input stays uncertain", async (t) => {
        const cases = [
            { name: "native entry", queueEntryId: "native-present", native: true },
            { name: "claude input", queueEntryId: "claude:message-2", native: false },
        ] as const;
        for (const scenario of cases) {
            const f = await fixture(t);
            await f.runtime.dispose();
            f.native.running = false;
            const message = recoveredMessage({
                messageId: `recovered-${scenario.queueEntryId}`,
                invocationId: JSON.stringify([parent, scenario.queueEntryId]),
                queueEntryId: scenario.queueEntryId,
                receipt: {
                    subSessionId: child,
                    messageId: `recovered-${scenario.queueEntryId}`,
                    runId: "previous-run",
                    status: "queued",
                    effectiveDelivery: "followUp",
                    resultText: "Message accepted.",
                    isError: false,
                },
            });
            await f.registry.withSession(child, (session) =>
                writeAgentMessages(session, [message]),
            );
            if (scenario.native) {
                f.native.entries.push({
                    entryId: scenario.queueEntryId,
                    kind: "followUp",
                    text: agentMessageEnvelope(message),
                });
            }
            const starts: AgentMessageRecord[] = [];
            const restarted = new AgentConversationRuntime({
                registry:
                    f.registry as unknown as import("../../src/runtime/session/sessionRegistry.ts").SessionRegistry,
                findAgent: () => undefined,
                async start(started) {
                    starts.push(started);
                    const receipt = started.receipt;
                    assert.ok(receipt);
                    return {
                        result: {
                            ...receipt,
                            status: "started",
                            runId: `restarted-${scenario.queueEntryId}`,
                            resultText: "restarted",
                            isError: false,
                        },
                    };
                },
            });
            f.runtimes.push(restarted);
            f.registry.emit("session.attached", { sessionId: parent });
            await f.registry.drain();
            if (scenario.native) {
                assert.equal(starts.length, 1, `${scenario.name} should be restartable`);
                assert.equal(starts[0]?.queueEntryId, scenario.queueEntryId);
                assert.equal((await f.records())[0]?.receipt?.status, "started");
            } else {
                assert.equal(
                    starts.length,
                    0,
                    `${scenario.name} cannot be confirmed after restart`,
                );
                const persisted = (await f.records())[0];
                assert.equal(persisted?.receipt?.status, "error");
                assert.equal(persisted?.receipt?.isError, true);
                assert.match(persisted?.receipt?.resultText ?? "", /uncertain/i);
            }
        }
    });

    it("does not convert a started journal entry with no terminal state into completion after restart", async (t) => {
        const f = await fixture(t);
        await f.runtime.dispose();
        const message = recoveredMessage({
            receipt: {
                subSessionId: child,
                messageId: "recovered-message",
                runId: "started-without-end",
                status: "started",
                effectiveDelivery: "followUp",
                resultText: "The existing agent conversation is continuing.",
                isError: false,
            },
        });
        await f.registry.withSession(child, (session) => writeAgentMessages(session, [message]));
        const starts: AgentMessageRecord[] = [];
        const restarted = new AgentConversationRuntime({
            registry:
                f.registry as unknown as import("../../src/runtime/session/sessionRegistry.ts").SessionRegistry,
            findAgent: () => undefined,
            async start(started) {
                starts.push(started);
                const receipt = started.receipt;
                assert.ok(receipt);
                return { result: receipt };
            },
        });
        f.runtimes.push(restarted);
        f.registry.emit("session.attached", { sessionId: parent });
        await f.registry.drain();
        assert.equal(starts.length, 0);
        const persisted = (await f.records())[0];
        assert.equal(persisted?.receipt?.status, "started");
        assert.notEqual(persisted?.receipt?.status, "completed");
        assert.equal(persisted?.receipt?.isError, false);
    });
});
