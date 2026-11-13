import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    type AgentSessionDescriptor,
    asSessionId,
    type ChatToAgentToolDetails,
    type SubagentSettledPayload,
    type SubagentSpawnedPayload,
} from "@taco-ai/protocol";
import { Value } from "typebox/value";
import type {
    AgentChatArgs,
    AgentChatResult,
    AgentConversationContext,
} from "../../src/agents/agentConversationTypes.ts";
import type { AgentToolResult } from "../../src/runtime/pi/types.ts";
import { createChatToAgentTool } from "../../src/tools/chatToAgent.ts";
import { createListAgentSessionsTool } from "../../src/tools/listAgentSessions.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

const receipt: ChatToAgentToolDetails = {
    subSessionId: asSessionId("child-1"),
    messageId: "message-1",
    status: "queued",
    effectiveDelivery: "steer",
    runId: "run-1",
    resultPath: "/tmp/agent-results/run-1.md",
};

function context(result: Partial<AgentChatResult> = {}): AgentConversationContext {
    return {
        chat: async () => ({ ...receipt, resultText: "", isError: false, ...result }),
        list: async () => [],
    };
}

function text(result: AgentToolResult<unknown>): string {
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("chatToAgent tool", () => {
    it("forwards default delivery and background explicitly with cancellation and progress", async () => {
        let captured: AgentChatArgs | undefined;
        const ctx = context();
        ctx.chat = async (args) => {
            captured = args;
            return { ...receipt, resultText: "", isError: false };
        };
        const signal = new AbortController().signal;
        const onUpdate = (): void => {};
        await invokeTool(
            createChatToAgentTool(ctx),
            { subSessionId: "child-1", prompt: "Check the current patch" },
            {},
            { toolCallId: "parent-call", signal, onUpdate },
        );
        assert.deepEqual(captured, {
            parentToolCallId: "parent-call",
            subSessionId: "child-1",
            prompt: "Check the current patch",
            delivery: "steer",
            background: true,
            inReplyTo: undefined,
            signal,
            onUpdate,
        });
    });

    it("preserves followUp, background false, and inReplyTo", async () => {
        let captured: AgentChatArgs | undefined;
        const ctx = context();
        ctx.chat = async (args) => {
            captured = args;
            return { ...receipt, status: "completed", resultText: "Reviewed", isError: false };
        };
        const result = await invokeTool(
            createChatToAgentTool(ctx),
            {
                subSessionId: "child-1",
                prompt: "Continue the review",
                delivery: "followUp",
                background: false,
                inReplyTo: "previous-message",
            },
            {},
        );
        assert.equal(captured?.delivery, "followUp");
        assert.equal(captured?.background, false);
        assert.equal(captured?.inReplyTo, "previous-message");
        assert.match(text(result), /Reviewed/);
        assert.doesNotMatch(text(result), /receipt is not completion/i);
    });

    for (const status of ["queued", "started"] as const) {
        it(`makes every ${status} receipt field model-visible without claiming completion`, async () => {
            const result = await invokeTool(
                createChatToAgentTool(context({ status, effectiveDelivery: "nextTurn" })),
                { subSessionId: "child-1", prompt: "Update" },
                {},
            );
            const body = text(result);
            for (const [key, value] of Object.entries({
                ...receipt,
                status,
                effectiveDelivery: "nextTurn",
            })) {
                assert.ok(body.includes(key), `${key} must be visible in content`);
                assert.ok(body.includes(String(value)), `${value} must be visible in content`);
            }
            assert.match(body, /accepted/i);
            assert.match(body, /receipt is not completion/i);
            assert.doesNotMatch(body, /interrupt.*tool/i);
            assert.deepEqual(result.details, {
                ...receipt,
                status,
                effectiveDelivery: "nextTurn",
            });
            assert.notEqual(result.isError, true);
        });
    }

    it("shows absent runId and resultPath explicitly without inventing them in details", async () => {
        const result = await invokeTool(
            createChatToAgentTool(context({ runId: undefined, resultPath: undefined })),
            { subSessionId: "child-1", prompt: "Update" },
            {},
        );
        assert.match(text(result), /"runId":\s*null/);
        assert.match(text(result), /"resultPath":\s*null/);
        assert.equal((result.details as ChatToAgentToolDetails).runId, undefined);
        assert.equal((result.details as ChatToAgentToolDetails).resultPath, undefined);
    });

    it("retains the completed answer and effective followUp delivery", async () => {
        const result = await invokeTool(
            createChatToAgentTool(
                context({ status: "completed", effectiveDelivery: "followUp", resultText: "Done" }),
            ),
            { subSessionId: "child-1", prompt: "Finish", background: false },
            {},
        );
        assert.match(text(result), /Done/);
        assert.match(text(result), /completed/);
        assert.deepEqual(result.details, {
            ...receipt,
            status: "completed",
            effectiveDelivery: "followUp",
        });
        assert.notEqual(result.isError, true);
    });

    for (const error of [
        { status: "error", isError: false },
        { status: "completed", isError: true },
    ] as const) {
        it(`marks a returned failure as isError (${JSON.stringify(error)})`, async () => {
            const result = await invokeTool(
                createChatToAgentTool(context({ ...error, resultText: "Target unavailable" })),
                { subSessionId: "child-1", prompt: "Update" },
                {},
            );
            assert.equal(result.isError, true);
            assert.match(text(result), /error/i);
            assert.match(text(result), /Target unavailable/);
        });
    }

    it("keeps aborted distinct from failure even when the context returns isError", async () => {
        const result = await invokeTool(
            createChatToAgentTool(
                context({ status: "aborted", isError: true, resultText: "Stopped deliberately" }),
            ),
            { subSessionId: "child-1", prompt: "Update" },
            {},
        );
        assert.notEqual(result.isError, true);
        assert.match(text(result), /Stopped deliberately/);
        assert.doesNotMatch(text(result), /chat error/i);
        assert.deepEqual(result.details, { ...receipt, status: "aborted" });
    });

    it("exposes a parallel mutating tool and optional schema defaults", () => {
        const tool = createChatToAgentTool(context());
        assert.equal(tool.name, "chatToAgent");
        assert.equal(tool.label, tool.name);
        assert.equal(tool.executionMode, "parallel");
        assert.equal(tool.taco?.mutates, true);
        assert.ok(tool.taco?.promptSummary);
        const minimal = { subSessionId: "child-1", prompt: "Update" };
        assert.equal(Value.Check(tool.parameters, minimal), true);
        assert.deepEqual(Value.Default(tool.parameters, { ...minimal }), {
            ...minimal,
            delivery: "steer",
            background: true,
        });
        assert.equal(Value.Check(tool.parameters, { prompt: "Update" }), false);
        assert.equal(Value.Check(tool.parameters, { subSessionId: "child-1" }), false);
        assert.equal(Value.Check(tool.parameters, { ...minimal, delivery: "nextTurn" }), false);
        assert.equal(Value.Check(tool.parameters, { ...minimal, background: "true" }), false);
        assert.equal(Value.Check(tool.parameters, { ...minimal, inReplyTo: 1 }), false);
    });

    it("explains creation, continuation, communication scope, and delivery limits", () => {
        const tool = createChatToAgentTool(context());
        const description = `${tool.description} ${JSON.stringify(tool.parameters)}`;
        assert.match(description, /`agent`/);
        assert.match(description, /running/i);
        assert.match(description, /settled|finished|ended/i);
        assert.match(description, /same parent/i);
        assert.match(description, /yourself/i);
        assert.match(description, /not automatically sync/i);
        assert.match(description, /background: false/);
        assert.match(description, /idle child/i);
        assert.match(description, /nextTurn/);
        assert.match(description, /does not interrupt.*tool/i);
        assert.match(description, /Codex queues/i);
        assert.match(description, /current turn/i);
    });
});

describe("listAgentSessions tool", () => {
    const session: AgentSessionDescriptor = {
        subSessionId: asSessionId("child-2"),
        agentType: "reviewer",
        description: "Review the patch",
        status: "idle",
        canResume: true,
        delivery: "steer",
    };

    it("returns model-visible instance descriptors, without exposing extra context fields", async () => {
        const ctx = context();
        ctx.list = async () => [{ ...session, transcript: "private history" }];
        const result = await invokeTool(createListAgentSessionsTool(ctx), {}, {});
        assert.deepEqual(JSON.parse(text(result)), { sessions: [session] });
        assert.deepEqual(result.details, { sessions: [session] });
        assert.doesNotMatch(text(result), /transcript|private history/);
    });

    it("reads current instances on every call and preserves all status and delivery variants", async () => {
        let sessions: AgentSessionDescriptor[] = [];
        const ctx = context();
        ctx.list = async () => sessions;
        const tool = createListAgentSessionsTool(ctx);
        await invokeTool(tool, {}, {});
        sessions = (["running", "idle", "preparing", "settling"] as const).map((status, index) => ({
            ...session,
            status,
            delivery: index === 0 ? "nextTurn" : index === 1 ? "steer" : "queued",
            canResume: false,
        }));
        const result = await invokeTool(tool, {}, {});
        assert.deepEqual(JSON.parse(text(result)), { sessions });
    });

    it("explicitly says when no other agents are available for communication", async () => {
        const result = await invokeTool(createListAgentSessionsTool(context()), {}, {});
        assert.match(text(result), /no other agents.*communicat/i);
        assert.deepEqual(result.details, { sessions: [] });
    });

    it("bounds the snapshot and descriptions without mutating the context's objects", async () => {
        const sessions = Array.from({ length: 101 }, (_, index) => ({
            ...session,
            subSessionId: asSessionId(`child-${index}`),
            description: "x".repeat(600),
        }));
        const ctx = context();
        ctx.list = async () => sessions;
        const result = await invokeTool(createListAgentSessionsTool(ctx), {}, {});
        const snapshot = JSON.parse(text(result)) as {
            sessions: AgentSessionDescriptor[];
            omitted: number;
        };
        assert.equal(snapshot.sessions.length, 100);
        assert.equal(snapshot.omitted, 1);
        assert.ok(snapshot.sessions.every((entry) => (entry.description?.length ?? 0) <= 500));
        assert.equal(sessions[0]?.description.length, 600);
    });

    it("declares a read-only parallel tool with empty arguments", () => {
        const tool = createListAgentSessionsTool(context());
        assert.equal(tool.name, "listAgentSessions");
        assert.equal(tool.label, tool.name);
        assert.equal(tool.executionMode, "parallel");
        assert.equal(tool.taco?.mutates, false);
        assert.ok(tool.taco?.promptSummary);
        assert.equal(Value.Check(tool.parameters, {}), true);
        assert.equal(Value.Check(tool.parameters, { subSessionId: "child-1" }), false);
    });
});

it("keeps spawn and settle payloads compatible with optional run identity", () => {
    const spawned: SubagentSpawnedPayload = {
        parentSessionId: asSessionId("parent"),
        parentToolCallId: "parent-call",
        subSessionId: asSessionId("child-1"),
        agentType: "reviewer",
    };
    const settled: SubagentSettledPayload = { ...spawned, outcome: "completed", runId: "run-1" };
    const resumed: SubagentSpawnedPayload = { ...spawned, runId: "run-1" };
    assert.equal(spawned.runId, undefined);
    assert.equal(resumed.runId, settled.runId);
});
