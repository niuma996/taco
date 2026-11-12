import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/compat";
import {
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { asSessionId } from "@taco-ai/protocol";
import { Type } from "typebox";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import type { AgentLane } from "../../src/runtime/pi/types.ts";
import { findBranchEntries } from "../../src/runtime/session/sessionBranch.ts";
import {
    type AgentMessageRecord,
    agentMessageEnvelope,
} from "../../src/runtime/subagent/agentConversation.ts";
import { readAgentMessages, writeAgentMessages } from "../../src/runtime/subagent/agentMessages.ts";
import { createChatToAgentTool } from "../../src/tools/chatToAgent.ts";
import type { TacoTool } from "../../src/tools/index.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

type ModelContext = Parameters<FauxResponseFactory>[0];

function gate() {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

function messageText(content: ModelContext["messages"][number]["content"]): string {
    return typeof content === "string"
        ? content
        : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function userText(context: ModelContext): string {
    return context.messages
        .filter((message) => message.role === "user")
        .map((message) => messageText(message.content))
        .join("\n");
}

function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}

async function fixture(t: TestContext, maxTurns = 8) {
    const entered = gate();
    const blocked = gate();
    const probe: TacoTool = {
        name: "chatProbe",
        label: "chatProbe",
        description: "A local test checkpoint.",
        parameters: Type.Object({}),
        executionMode: "parallel",
        async execute() {
            entered.release();
            await blocked.promise;
            return { content: [{ type: "text", text: "Checkpoint complete" }], details: {} };
        },
    };
    const definition: AgentDefinition = {
        agentType: "chat-worker",
        description: "A standard engine communication worker.",
        systemPrompt: "Use the supplied conversation and communication tools.",
        tools: ["chatProbe", "chatToAgent", "listAgentSessions", "agent"],
        maxTurns,
        runtime: "standard",
        source: "builtin",
        filePath: "/agents/chat-worker.md",
    };
    const faux = fauxProvider({ provider: "agent-chat-faux", tokensPerSecond: 0 });
    const models = createModels();
    models.setProvider(faux.provider);
    const workspace = createTestWorkspace({
        prefix: "agent-chat-faux",
        models,
        defaultModel: faux.getModel(),
        tools: [probe],
        agents: [definition],
        compaction: { enabled: false, threshold: 0 },
    });
    t.after(async () => {
        blocked.release();
        await workspace.cleanup();
    });
    const parent = asSessionId("parent");
    await workspace.ws.sessionRegistry.createSession(parent, undefined, async (session) => {
        await session.setValue(
            (await import("../../src/runtime/session/sessionFacts.ts")).SESSION_FACTS,
            { kind: "main", depth: 0 },
            harnessContext,
        );
    });
    const spawner = workspace.ws.agentSpawner;
    const chat = createChatToAgentTool({
        chat: (args) => spawner.chatToAgent(parent, args),
        list: () => spawner.listAgentSessions(parent),
    });
    const spawn = () =>
        workspace.ws.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "spawn-call",
            agentType: definition.agentType,
            prompt: "PRIOR_TASK_SEED: inspect the patch and report the finding.",
        });
    return { ...workspace, faux, entered, blocked, parent, spawner, chat, spawn };
}

describe("agent chat with the real standard harness and faux provider", { timeout: 8_000 }, () => {
    it("feeds parent steer and followUp into model context and changes the final answer", async (t) => {
        const f = await fixture(t);
        const observed: ModelContext[] = [];
        f.faux.setResponses([
            (context) => {
                observed.push(structuredClone(context));
                return fauxAssistantMessage(fauxToolCall("chatProbe", {}, { id: "probe-1" }), {
                    stopReason: "toolUse",
                });
            },
            (context) => {
                observed.push(structuredClone(context));
                return fauxAssistantMessage(
                    userText(context).includes("STEER_CHANGE_TO_BLUE") ? "blue" : "unchanged",
                );
            },
            (context) => {
                observed.push(structuredClone(context));
                const input = userText(context);
                return fauxAssistantMessage(
                    input.includes("STEER_CHANGE_TO_BLUE") &&
                        input.includes("FOLLOWUP_ADD_TRIANGLE")
                        ? "blue triangle"
                        : "missing parent context",
                );
            },
        ]);
        const run = f.spawn();
        try {
            await f.entered.promise;
            const [session] = await f.spawner.listAgentSessions(f.parent);
            assert.ok(session);
            assert.equal(session.status, "running");
            for (const [delivery, prompt] of [
                ["steer", "STEER_CHANGE_TO_BLUE"],
                ["followUp", "FOLLOWUP_ADD_TRIANGLE"],
            ] as const) {
                const receipt = await invokeTool(
                    f.chat,
                    { subSessionId: session.subSessionId, prompt, delivery },
                    {},
                    { toolCallId: `parent-${delivery}` },
                );
                assert.notEqual(receipt.isError, true);
            }
            const attached = f.ws.sessionRegistry.getAttached(session.subSessionId);
            assert.ok(attached);
            const tools = await attached.toolController?.activeToolNames();
            for (const name of ["chatToAgent", "listAgentSessions", "chatProbe"]) {
                assert.ok(tools?.includes(name), `${name} must be in the actual child toolset`);
            }
            assert.ok(!tools?.includes("agent"), "child cannot recursively spawn an agent");
        } finally {
            f.blocked.release();
        }
        const result = await run;
        assert.equal(result.isError, false, result.resultText);
        assert.equal(result.resultText, "blue triangle");
        assert.equal(observed.length, 3);
        assert.equal(occurrences(userText(observed[1]), "STEER_CHANGE_TO_BLUE"), 1);
        assert.equal(occurrences(userText(observed[1]), "FOLLOWUP_ADD_TRIANGLE"), 0);
        assert.equal(occurrences(userText(observed[2]), "STEER_CHANGE_TO_BLUE"), 1);
        assert.equal(occurrences(userText(observed[2]), "FOLLOWUP_ADD_TRIANGLE"), 1);
    });

    it("retains prior transcript on idle chat while granting a fresh maxTurns budget", async (t) => {
        const f = await fixture(t, 3);
        f.blocked.release();
        const prior: ModelContext[] = [];
        const resumed: ModelContext[] = [];
        f.faux.setResponses([
            (context) => {
                prior.push(structuredClone(context));
                return fauxAssistantMessage(fauxToolCall("chatProbe", {}, { id: "old-1" }), {
                    stopReason: "toolUse",
                });
            },
            (context) => {
                prior.push(structuredClone(context));
                return fauxAssistantMessage(fauxToolCall("chatProbe", {}, { id: "old-2" }), {
                    stopReason: "toolUse",
                });
            },
            (context) => {
                prior.push(structuredClone(context));
                return fauxAssistantMessage("PRIOR_FINDING_COPPER");
            },
            (context) => {
                resumed.push(structuredClone(context));
                return fauxAssistantMessage(fauxToolCall("chatProbe", {}, { id: "new-1" }), {
                    stopReason: "toolUse",
                });
            },
            (context) => {
                resumed.push(structuredClone(context));
                const history = context.messages
                    .map((message) => messageText(message.content))
                    .join("\n");
                return fauxAssistantMessage(
                    history.includes("PRIOR_TASK_SEED") && history.includes("PRIOR_FINDING_COPPER")
                        ? "Copper finding retained; new task verified"
                        : "lost prior transcript",
                );
            },
        ]);
        const initial = await f.spawn();
        assert.equal(initial.isError, false, initial.resultText);
        assert.ok(initial.subSessionId);
        assert.equal(prior.length, 3, "the first task must consume its entire three-turn budget");
        const entries = await f.ws.sessionRegistry.withSession(
            initial.subSessionId,
            findBranchEntries,
        );
        assert.equal(
            entries.filter(
                (entry) => entry.type === "message" && entry.message.role === "assistant",
            ).length,
            3,
        );
        const reply = await invokeTool(
            f.chat,
            {
                subSessionId: initial.subSessionId,
                prompt: "NEW_TASK_VERIFY_COPPER",
                background: false,
            },
            {},
            { toolCallId: "idle-parent-chat" },
        );
        assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
        assert.ok(
            reply.content.some(
                (part) =>
                    part.type === "text" &&
                    part.text.includes("Copper finding retained; new task verified"),
            ),
        );
        assert.equal(
            resumed.length,
            2,
            "a new chat task must have budget for another tool round trip",
        );
        const first = resumed[0];
        assert.ok(first);
        const contextText = first.messages
            .map((message) => messageText(message.content))
            .join("\n");
        assert.match(contextText, /PRIOR_FINDING_COPPER/);
        assert.match(userText(first), /NEW_TASK_VERIFY_COPPER/);
        assert.match(
            userText(first),
            /Turn 0\/3 \(3 left\)/,
            "budget reminder must reset with the new task",
        );
    });

    it("wakes a real run for a retained native tail entry without duplicating its body in context", async (t) => {
        const f = await fixture(t);
        f.faux.setResponses([fauxAssistantMessage("Initial task complete")]);
        const initial = await f.spawn();
        assert.equal(initial.isError, false, initial.resultText);
        assert.ok(initial.subSessionId);
        const child = initial.subSessionId;
        const attached = f.ws.sessionRegistry.getAttached(child);
        assert.ok(attached);
        // Seed the exact tail boundary: execution has stopped, but the native
        // write committed. Both the native queue and receipt journal are real.
        const message: AgentMessageRecord = {
            messageId: "tail-message",
            invocationId: JSON.stringify([f.parent, "tail-parent-call"]),
            senderSessionId: f.parent,
            targetSessionId: child,
            ownerParentSessionId: f.parent,
            relation: "parent",
            prompt: "TAIL_BODY_ONLY_ONCE",
            delivery: "followUp",
            background: true,
            createdAt: Date.now(),
            receipt: {
                subSessionId: child,
                messageId: "tail-message",
                runId: "tail-run",
                status: "queued",
                effectiveDelivery: "followUp",
                resultText: "Accepted",
                isError: false,
            },
        };
        const lane = (attached as unknown as { lane: AgentLane }).lane;
        const queued = await lane.followUp(
            agentMessageEnvelope(message),
            undefined,
            harnessContext,
        );
        assert.equal(queued.ok, true);
        if (!queued.ok) throw new Error("Could not seed native tail queue");
        message.queueEntryId = queued.value.entryId;
        await f.ws.sessionRegistry.withSession(child, (session) =>
            writeAgentMessages(session, [message]),
        );
        const observed: ModelContext[] = [];
        const answered = gate();
        f.faux.setResponses([
            (context) => {
                observed.push(structuredClone(context));
                answered.release();
                return fauxAssistantMessage(
                    `Body count: ${occurrences(userText(context), message.prompt)}`,
                );
            },
        ]);
        f.spawner.conversation.begin(child, {
            runId: "tail-run",
            parentSessionId: f.parent,
            phase: "settling",
        });
        await f.spawner.conversation.end(child, "tail-run", {
            subSessionId: child,
            resultText: "Initial task complete",
            isError: false,
        });
        await answered.promise;
        await f.spawner.whenBackgroundRunsSettle();
        // Allow run_end/idle-driven dispatches to observe the terminal receipt.
        await nextImmediate();
        assert.equal(observed.length, 1, "one tail message should start one model turn");
        assert.equal(
            occurrences(userText(observed[0]), message.prompt),
            1,
            "wake prompt must reference the queue instead of copying the body",
        );
        const persisted = await f.ws.sessionRegistry.withSession(child, readAgentMessages);
        assert.equal(persisted[0]?.receipt?.status, "completed");
        assert.equal(persisted[0]?.receipt?.resultText, "Body count: 1");
        const watch = await attached.watchSnapshot();
        try {
            assert.equal(watch.snapshot.queues.length, 0);
        } finally {
            watch.unsubscribe();
        }
    });
});
