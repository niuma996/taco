/**
 * AgentSpawner with a `runtime: claude-code` agent, end to end through the
 * real session repo. The SDK is faked; no CLI or network.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { readSessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import type {
    ClaudeAgentSdk,
    SdkMessage,
    SdkQueryOptions,
} from "../../src/runtime/subagent/claudeCode/claudeCodeSdk.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
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

    it("rejects context: fork before creating a child session", async () => {
        const parent = await seedParent();
        const r = await ws.agentSpawner.spawnSubagent({
            parentSessionId: parent,
            parentToolCallId: "call-3",
            agentType: "cc",
            prompt: "x",
            context: "fork",
        });
        assert.equal(r.isError, true);
        assert.equal(r.subSessionId, undefined);
        assert.match(r.resultText, /only supports context "independent"/);
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
