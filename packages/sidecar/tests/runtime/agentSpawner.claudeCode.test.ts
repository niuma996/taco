/**
 * AgentSpawner with a `runtime: claude-code` agent, end to end through the
 * real session repo. The SDK is faked; no CLI or network.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentDefinition, SubagentSpawnContext } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { readSessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import type {
    ClaudeAgentSdk,
    SdkMessage,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createAgentTool } from "../../src/tools/agent.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

const defs: AgentDefinition[] = [
    {
        agentType: "cc",
        description: "claude code reader",
        systemPrompt: "you read",
        maxTurns: 7,
        runtime: "claude-code",
        source: "user",
        filePath: "/x/cc.md",
    },
];

type Frames = (options: SdkQueryOptions) => AsyncIterable<SdkMessage>;

async function* readThenAnswer(): AsyncIterable<SdkMessage> {
    yield { type: "system", subtype: "init" };
    yield {
        type: "assistant",
        message: {
            id: "a1",
            content: [
                { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } },
            ],
        },
    };
    yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hello" }] },
    };
    yield {
        type: "assistant",
        message: { id: "a2", content: [{ type: "text", text: "It says hello." }] },
    };
    yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "It says hello.",
        num_turns: 2,
    };
}

describe("AgentSpawner — runtime: claude-code", () => {
    let cwd: string;
    let ws: WorkspaceRuntime;
    let cleanup: () => Promise<void>;
    let frames: Frames = readThenAnswer;
    let lastOptions: SdkQueryOptions | undefined;

    before(() => {
        ({ ws, cwd, cleanup } = createTestWorkspace({ prefix: "cc", agents: defs }));
        const sdk: ClaudeAgentSdk = {
            query({ options }) {
                lastOptions = options;
                return frames(options);
            },
        };
        const spawner = ws.agentSpawner as unknown as {
            loadClaudeCodeSdk: () => Promise<ClaudeAgentSdk>;
            findClaudeCode: () => string | undefined;
        };
        spawner.loadClaudeCodeSdk = async () => sdk;
        spawner.findClaudeCode = () => "/usr/local/bin/claude";
    });

    after(() => cleanup());

    async function seedParent(): Promise<SessionId> {
        const id = asSessionId(`parent-${Math.random().toString(36).slice(2)}`);
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        await session.close(harnessContext);
        ws.sessionRegistry.invalidateListCache();
        return id;
    }

    /** Parent with one message — fork renders nothing from an empty branch. */
    async function seedParentWithMessage(): Promise<SessionId> {
        const id = asSessionId(`parent-${Math.random().toString(36).slice(2)}`);
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        const branch = await session.createBranch("main", null, harnessContext);
        await branch.appendMessage(
            { role: "user", content: "earlier context", timestamp: Date.now() },
            harnessContext,
        );
        await session.close(harnessContext);
        ws.sessionRegistry.invalidateListCache();
        return id;
    }

    it("runs synchronously, returns the answer, and persists a readable transcript", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const r = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-1",
            agentType: "cc",
            prompt: "what does the readme say",
        });
        assert.equal(r.isError, false, r.resultText);
        assert.equal(r.resultText, "It says hello.");
        assert.ok(r.subSessionId);
        assert.equal(lastOptions?.cwd, cwd);
        assert.equal(lastOptions?.maxTurns, 7);
        assert.equal(lastOptions?.systemPrompt.append, "you read");

        const hist = await ws.getHistory(r.subSessionId);
        const roles = hist.entries.map((e) => (e as { message?: { role?: string } }).message?.role);
        assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);

        const facts = await ws.sessionRegistry.withSession(r.subSessionId, (s) =>
            readSessionFacts(s),
        );
        assert.equal(facts.runtime, "claude-code");
        assert.equal(facts.kind, "subagent");
        assert.equal(facts.parentSessionId, parent);
    });

    it("publishes a started update carrying subSessionId, so the card is clickable while running", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const updates: Array<Record<string, unknown>> = [];
        await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-live",
            agentType: "cc",
            prompt: "x",
            onUpdate: (payload) => {
                updates.push(payload as unknown as Record<string, unknown>);
            },
        });
        const started = updates[0];
        assert.ok(started, "no progress update was published");
        const startedDetails = started.details as { subSessionId?: string; agentType?: string };
        assert.equal(startedDetails.agentType, "cc");
        assert.ok(startedDetails.subSessionId, "started update carried no subSessionId");
        // Every update carries the id — that is what makes a running card openable.
        for (const u of updates) {
            assert.ok(
                (u.details as { subSessionId?: string })?.subSessionId,
                `update without subSessionId: ${JSON.stringify(u)}`,
            );
        }
    });

    it("streams child messages as pi-style events so the panel updates live", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const events: Array<{ type: string; toolCallId?: string; toolName?: string }> = [];
        ws.on("session.event", (e: { sessionId: string; event: Record<string, unknown> }) => {
            if (e.sessionId !== undefined && e.sessionId !== parent) {
                events.push({
                    type: e.event.type as string,
                    toolCallId: e.event.toolCallId as string | undefined,
                    toolName: e.event.toolName as string | undefined,
                });
            }
        });
        await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-live",
            agentType: "cc",
            prompt: "x",
        });
        const kinds = events.map((e) => e.type);
        // pi's order: every assistant message opens its bubble before its tool
        // calls arrive. The desktop attaches tool events to the last bubble, so
        // a tool_start ahead of message_start renders as a fallback text row
        // ("▶ Read" / "✓ Read: …") instead of a card.
        assert.deepEqual(kinds, [
            "message_end", // user prompt
            "message_start", // assistant: tool call
            "message_end",
            "tool_start",
            "tool_end", // its result fills the card
            "message_start", // assistant: final reply
            "message_end",
        ]);
        assert.equal(events[3]?.toolName, "Read");
        assert.equal(events[4]?.toolName, "Read");
    });

    it("stops through abortSubagentRun, like a pi subagent", async () => {
        let started: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        frames = (options) =>
            (async function* () {
                started();
                await new Promise<void>((resolve) =>
                    options.abortController.signal.addEventListener("abort", () => resolve(), {
                        once: true,
                    }),
                );
                throw new Error("Claude Code process aborted by user");
            })();
        const parent = await seedParent();
        let childId: string | undefined;
        ws.agentSpawner.once("subagent.spawned", (e: { subSessionId: string }) => {
            childId = e.subSessionId;
        });
        const pending = ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-2",
            agentType: "cc",
            prompt: "wait",
        });
        await running;
        assert.ok(childId);
        assert.equal(ws.agentSpawner.abortSubagentRun(childId, parent), true);
        const r = await pending;
        assert.equal(r.isError, true);
        assert.match(r.resultText, /deliberate interruption/);
        assert.equal(ws.agentSpawner.abortSubagentRun(childId, parent), false);
    });

    it("runs in the background and settles through the shared completion path", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const settled = new Promise<{ outcome: string; subSessionId: string }>((resolve) => {
            ws.agentSpawner.once("subagent.settled", resolve);
        });
        const receipt = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-bg",
            agentType: "cc",
            prompt: "x",
            background: true,
        });
        assert.equal(receipt.isError, false, receipt.resultText);
        assert.equal(receipt.background, true);
        assert.ok(receipt.resultPath);
        const s = await settled;
        assert.equal(s.outcome, "completed");
        assert.equal(s.subSessionId, receipt.subSessionId);
        await ws.agentSpawner.whenBackgroundRunsSettle();
        assert.equal(await readFile(receipt.resultPath, "utf-8"), "It says hello.");
    });

    it("corrects context: fork to independent instead of failing", async () => {
        // The model cannot pass a runtime, so it may ask a claude-code agent
        // for fork context it cannot have. Correcting it is friendlier than an
        // error — the spawner already decided the mode before creating the
        // child, so nothing is lost.
        frames = readThenAnswer;
        const parent = await seedParentWithMessage();
        const r = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-3",
            agentType: "cc",
            prompt: "x",
            context: "fork",
        });
        assert.equal(r.isError, false, r.resultText);
        assert.ok(r.subSessionId);
        // The real assertion: the fork block never ran. Asserting only on
        // success would pass either way — the claude-code runner ignores
        // `forkedContext`, so a missing downgrade is invisible to the result.
        // It is still wrong: it renders the whole parent transcript and
        // persists it into the child's facts for a child that cannot use it.
        const facts = await ws.sessionRegistry.withSession(r.subSessionId, (sess) =>
            readSessionFacts(sess),
        );
        assert.equal(facts.forkedContext, undefined);
    });

    it("refuses agentContinue on a claude-code child", async () => {
        frames = readThenAnswer;
        const parent = await seedParent();
        const first = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-4",
            agentType: "cc",
            prompt: "x",
        });
        assert.ok(first.subSessionId);
        const r = await ws.agentSpawner.resumeSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-5",
            subSessionId: first.subSessionId,
            prompt: "more",
        });
        assert.equal(r.isError, true);
        assert.match(r.resultText, /cannot be resumed/);
    });
});

// Reload path used by agents.write/delete: the workspace swaps the catalog
// into the spawner and rebuilds <available_agents> only when it changed.
import {
    after as afterReload,
    before as beforeReload,
    describe as describeReload,
    it as itReload,
} from "node:test";

describeReload("WorkspaceRuntime.reloadAgentsNow", () => {
    let ws2: WorkspaceRuntime;
    let cleanup2: () => Promise<void>;
    beforeReload(() => {
        ({ ws: ws2, cleanup: cleanup2 } = createTestWorkspace({
            prefix: "cc-reload",
            agents: defs,
        }));
    });
    afterReload(() => cleanup2());

    itReload("keeps the runtime out of everything the model sees", () => {
        // The model delegates by agent name only; the spawner picks the engine.
        const prompt = ws2.systemPrompt;
        assert.ok(prompt.includes("<name>cc</name>"));
        assert.ok(!/claude-code|runtime/i.test(prompt.slice(prompt.indexOf("<available_agents>"))));
        const agentTool = createAgentTool({} as SubagentSpawnContext, []);
        const schema = JSON.stringify(agentTool.parameters);
        assert.ok(!/runtime|claude-code/i.test(schema), schema);
    });

    itReload("makes a newly written claude-code agent spawnable without a rebuild", () => {
        const added: AgentDefinition = {
            agentType: "cc2",
            description: "second",
            systemPrompt: "you read more",
            runtime: "claude-code",
            source: "user",
            filePath: "/x/cc2.md",
        };
        const promptBefore = ws2.agentSpawner.findAgent("cc2");
        assert.equal(promptBefore, undefined);
        ws2.reloadAgentsNow([...defs, added]);
        assert.equal(ws2.agentSpawner.findAgent("cc2")?.runtime, "claude-code");
        assert.ok(ws2.systemPrompt.includes("cc2"));
    });
});
