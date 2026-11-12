import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { readSessionFacts, type SessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import { readAgentMessages } from "../../src/runtime/subagent/agentMessages.ts";
import type {
    ClaudeAgentSdk,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";
import { readClaudeCodeState } from "../../src/runtime/subagent/claudeCode/claudeCodeState.ts";
import type { SubagentRunResult } from "../../src/runtime/subagent/subagentRunner.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { createTestWorkspace, type TestWorkspace } from "../_helpers/testWorkspace.ts";

const agents: AgentDefinition[] = [
    {
        agentType: "explorer",
        description: "Search",
        systemPrompt: "Explore",
        maxTurns: 10,
        source: "builtin",
        filePath: "/agents/explorer.md",
    },
];

describe("agent chat integration", () => {
    let fixture: TestWorkspace;
    afterEach(async () => {
        if (fixture) await fixture.cleanup();
    });

    async function setup() {
        fixture = createTestWorkspace({ agents, prefix: "agent-chat" });
        const registry = fixture.ws.sessionRegistry;
        async function seed(id: string, facts: SessionFacts = {}) {
            await registry.createSession(
                asSessionId(id),
                facts.parentSessionId ? asSessionId(facts.parentSessionId) : undefined,
                async (session) => {
                    const { writeSessionFacts } = await import(
                        "../../src/runtime/session/sessionFacts.ts"
                    );
                    await writeSessionFacts(session, facts);
                },
            );
        }
        await seed("p");
        await seed("other");
        for (const id of ["a", "b"])
            await seed(id, {
                kind: "subagent",
                parentSessionId: "p",
                agentType: "explorer",
                depth: 1,
            });
        await seed("foreign", {
            kind: "subagent",
            parentSessionId: "other",
            agentType: "explorer",
            depth: 1,
        });
        return fixture.ws;
    }

    it("discovers only the caller's immediate family", async () => {
        const ws = await setup();
        assert.deepEqual(
            (await ws.agentSpawner.listAgentSessions(asSessionId("a")))
                .map((entry) => entry.subSessionId)
                .sort(),
            ["b"],
        );
        assert.deepEqual(
            (await ws.agentSpawner.listAgentSessions(asSessionId("p")))
                .map((entry) => entry.subSessionId)
                .sort(),
            ["a", "b"],
        );
    });

    it("constructs discovery tools bound to the child's identity", async () => {
        const ws = await setup();
        const { tools } = await ws.sessionRegistry.toolsForChildSession(asSessionId("a"));
        const list = tools.find((tool) => tool.name === "listAgentSessions");
        assert.ok(list);
        assert.ok(tools.some((tool) => tool.name === "chatToAgent"));
        assert.ok(!tools.some((tool) => tool.name === "agent"));
        const result = await invokeTool(list, {}, {});
        const text = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
        assert.equal(JSON.parse(text).sessions[0].subSessionId, "b");
        assert.doesNotMatch(text, /foreign/);
    });

    it("retains session ownership while a peer starts a background continuation", async () => {
        const ws = await setup();
        const calls: {
            subSessionId: string;
            parentSessionId: string;
            prompt: string;
            newTask?: boolean;
        }[] = [];
        (
            ws.agentSpawner as unknown as {
                runResume: (args: (typeof calls)[number]) => Promise<SubagentRunResult>;
            }
        ).runResume = async (args) => {
            calls.push(args);
            return {
                subSessionId: asSessionId(args.subSessionId),
                resultText: "continued",
                isError: false,
            };
        };
        const result = await ws.agentSpawner.chatToAgent(asSessionId("a"), {
            subSessionId: asSessionId("b"),
            parentToolCallId: "peer-call",
            prompt: "Inspect this too",
        });
        assert.equal(result.status, "started");
        assert.ok(result.runId);
        await ws.agentSpawner.whenBackgroundRunsSettle();
        assert.equal(calls[0]?.parentSessionId, "p");
        assert.equal(calls[0]?.newTask, true);
        assert.match(calls[0]?.prompt ?? "", /relation="peer"/);
        assert.equal(
            (await ws.sessionRegistry.withSession(asSessionId("b"), readSessionFacts))
                .parentSessionId,
            "p",
        );
    });

    it("gives successive continuations different immutable result paths", async () => {
        const ws = await setup();
        (
            ws.agentSpawner as unknown as {
                runResume: (args: { subSessionId: string }) => Promise<SubagentRunResult>;
            }
        ).runResume = async (args) => ({
            subSessionId: asSessionId(args.subSessionId),
            resultText: "answer",
            isError: false,
        });
        const one = await ws.agentSpawner.chatToAgent(asSessionId("p"), {
            subSessionId: asSessionId("a"),
            parentToolCallId: "1",
            prompt: "first",
        });
        await ws.agentSpawner.whenBackgroundRunsSettle();
        const two = await ws.agentSpawner.chatToAgent(asSessionId("p"), {
            subSessionId: asSessionId("a"),
            parentToolCallId: "2",
            prompt: "second",
        });
        await ws.agentSpawner.whenBackgroundRunsSettle();
        assert.equal(one.isError, false);
        assert.equal(two.isError, false);
        assert.notEqual(one.resultPath, two.resultPath);
        const messages = await ws.sessionRegistry.withSession(asSessionId("a"), readAgentMessages);
        assert.equal(messages.length, 2);
        assert.ok(messages.every((record) => record.receipt?.status === "completed"));
    });

    it("rejects a cross-parent caller while the target is already executing", async () => {
        const ws = await setup();
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        (
            ws.agentSpawner as unknown as {
                runResume: (args: { subSessionId: string }) => Promise<SubagentRunResult>;
            }
        ).runResume = async (args) => {
            await blocked;
            return {
                subSessionId: asSessionId(args.subSessionId),
                resultText: "private",
                isError: false,
            };
        };
        try {
            const launched = await ws.agentSpawner.chatToAgent(asSessionId("p"), {
                subSessionId: asSessionId("a"),
                parentToolCallId: "1",
                prompt: "work",
            });
            assert.equal(launched.isError, false);
            const rejected = await ws.agentSpawner.chatToAgent(asSessionId("other"), {
                subSessionId: asSessionId("a"),
                parentToolCallId: "2",
                prompt: "give result",
            });
            assert.equal(rejected.isError, true);
            assert.doesNotMatch(rejected.resultText, /private/);
        } finally {
            release();
            await ws.agentSpawner.whenBackgroundRunsSettle();
        }
    });

    it("persists and resumes the exact native Claude Code conversation", async () => {
        const ws = await setup();
        const explorer = agents[0];
        assert.ok(explorer);
        ws.agentSpawner.replaceAgents([
            ...agents,
            { ...explorer, agentType: "cc", runtime: "claude-code", tools: ["Read"] },
        ]);
        const options: SdkQueryOptions[] = [];
        const sdk: ClaudeAgentSdk = {
            query: async function* (args) {
                options.push(args.options);
                yield { type: "system", subtype: "init", session_id: "native-cc-session" };
                yield {
                    type: "assistant",
                    message: { id: "reply", content: [{ type: "text", text: "native answer" }] },
                };
                yield { type: "result", subtype: "success", is_error: false, num_turns: 1 };
            },
        };
        Object.assign(ws.agentSpawner, {
            loadClaudeCodeSdk: async () => sdk,
            findClaudeCode: () => "/usr/bin/claude",
        });
        const initial = await ws.agentSpawner.spawnSubagent({
            parentSessionId: asSessionId("p"),
            parentToolCallId: "cc-first",
            agentType: "cc",
            prompt: "remember this",
        });
        assert.equal(initial.isError, false, initial.resultText);
        assert.ok(initial.subSessionId);
        const native = await ws.sessionRegistry.withSession(
            initial.subSessionId,
            readClaudeCodeState,
        );
        assert.equal(native?.nativeSessionId, "native-cc-session");
        const followUp = await ws.agentSpawner.chatToAgent(asSessionId("p"), {
            subSessionId: initial.subSessionId,
            parentToolCallId: "cc-follow",
            prompt: "what did you remember",
            background: false,
        });
        assert.equal(followUp.isError, false, followUp.resultText);
        assert.equal(options[1]?.resume, "native-cc-session");
        assert.deepEqual(
            options[1]?.mcpServers,
            {},
            "a profile without communication tools must not receive the bridge",
        );
    });

    it("authorizes legacy continuation before sharing a running result", async () => {
        const ws = await setup();
        let entered!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        (ws.agentSpawner as unknown as { runResume: () => Promise<SubagentRunResult> }).runResume =
            async () => {
                entered();
                await blocked;
                return {
                    subSessionId: asSessionId("a"),
                    resultText: "private-result",
                    isError: false,
                };
            };
        const own = ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId("p"),
            parentToolCallId: "own",
            subSessionId: asSessionId("a"),
            prompt: "work",
        });
        await ready;
        const foreign = ws.agentSpawner.resumeSubagent({
            parentSessionId: asSessionId("other"),
            parentToolCallId: "other",
            subSessionId: asSessionId("a"),
            prompt: "read",
        });
        release();
        await own;
        assert.equal((await foreign).isError, true);
        assert.doesNotMatch((await foreign).resultText, /private-result/);
    });
});
