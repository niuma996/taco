import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay, setImmediate as nextImmediate } from "node:timers/promises";
import { asSessionId, type SessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { readSessionFacts, writeSessionFacts } from "../../src/runtime/session/sessionFacts.ts";
import { readAgentMessages } from "../../src/runtime/subagent/agentMessages.ts";
import type {
    CodexSdkModule,
    CodexThread,
    CodexThreadEvent,
    CodexThreadOptions,
    LoadedCodexSdk,
} from "../../src/runtime/subagent/codex/codexSdk.ts";
import { readCodexState } from "../../src/runtime/subagent/codex/codexState.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
};

function fakeSdk(
    replies: string[],
    seen: {
        start?: CodexThreadOptions;
        resume?: { id: string; options?: CodexThreadOptions };
        starts?: number;
        resumes?: number;
        clientOptions?: Record<string, unknown>;
        wait?: Promise<void>;
        onEvent?: (event: CodexThreadEvent) => void;
        inputs?: string[];
        activeStreams?: number;
        maxActiveStreams?: number;
    },
): CodexSdkModule {
    let index = 0;
    const thread = (id: string): CodexThread => ({
        get id() {
            return id;
        },
        async runStreamed(input) {
            const text = replies[index++] ?? "missing reply";
            seen.inputs?.push(input);
            const events = (async function* (): AsyncGenerator<CodexThreadEvent> {
                seen.activeStreams = (seen.activeStreams ?? 0) + 1;
                seen.maxActiveStreams = Math.max(seen.maxActiveStreams ?? 0, seen.activeStreams);
                try {
                    yield { type: "thread.started", thread_id: id };
                    seen.onEvent?.({ type: "thread.started", thread_id: id });
                    yield {
                        type: "item.completed",
                        item: { id: `answer-${index}`, type: "agent_message", text },
                    };
                    if (seen.wait) await seen.wait;
                    yield { type: "turn.completed", usage };
                } finally {
                    seen.activeStreams -= 1;
                }
            })();
            return { events };
        },
    });
    return {
        Codex: class {
            constructor(options: Record<string, unknown> = {}) {
                seen.clientOptions = options;
            }
            startThread(options?: CodexThreadOptions): CodexThread {
                seen.start = options;
                seen.starts = (seen.starts ?? 0) + 1;
                return thread("thread-codex-1");
            }
            resumeThread(id: string, options?: CodexThreadOptions): CodexThread {
                seen.resume = { id, options };
                seen.resumes = (seen.resumes ?? 0) + 1;
                return thread(id);
            }
        } as CodexSdkModule["Codex"],
    };
}

describe("AgentSpawner — runtime: codex", () => {
    let cwd: string;
    let ws: WorkspaceRuntime;
    let cleanup: () => Promise<void>;
    const def: AgentDefinition = {
        agentType: "codex-reviewer",
        description: "reviews code with Codex",
        systemPrompt: "review carefully",
        runtime: "codex",
        codex: { model: "gpt-6", sandbox: "read-only", approvalPolicy: "never" },
        source: "user",
        filePath: "/agents/codex-reviewer.md",
    };

    before(() => {
        ({ ws, cwd, cleanup } = createTestWorkspace({
            prefix: "codex-spawn",
            agents: [def],
        }));
    });

    after(() => cleanup());

    async function seedParent(id: string): Promise<SessionId> {
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        await session.close(harnessContext);
        ws.sessionRegistry.invalidateListCache();
        return asSessionId(id);
    }

    function installSdk(sdk: CodexSdkModule): () => void {
        const spawner = ws.agentSpawner as unknown as {
            loadCodexSdkForRun: () => Promise<LoadedCodexSdk>;
        };
        const original = spawner.loadCodexSdkForRun;
        spawner.loadCodexSdkForRun = async () => ({
            module: sdk,
            version: "0.167.2",
            packageRoot: join(cwd, "missing-codex-sdk"),
            entryPath: join(cwd, "missing-codex-sdk", "dist", "index.js"),
        });
        return () => {
            spawner.loadCodexSdkForRun = original;
        };
    }

    it("spawns and resumes the exact persisted native thread", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["first answer", "continued answer"], seen));
        const spawned: Array<{ subSessionId?: string; runId?: string }> = [];
        const onSpawned = (event: { subSessionId?: string; runId?: string }) => spawned.push(event);
        ws.agentSpawner.on("subagent.spawned", onSpawned);
        try {
            const parent = await seedParent("codex-parent-1");
            const first = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-1",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.equal(first.isError, false, first.resultText);
            assert.equal(first.resultText, "first answer");
            assert.ok(first.subSessionId);
            assert.equal(spawned[0]?.subSessionId, first.subSessionId);
            assert.ok(spawned[0]?.runId);
            const canonicalCwd = await realpath(cwd);
            assert.equal(seen.start?.workingDirectory, canonicalCwd);
            assert.equal(seen.start?.model, "gpt-6");
            assert.equal(seen.start?.sandboxMode, "read-only");
            const mcpServers = seen.clientOptions?.config as
                | { mcp_servers?: Record<string, { command?: string; args?: string[] }> }
                | undefined;
            assert.equal(typeof mcpServers?.mcp_servers?.taco?.command, "string");
            assert.ok(mcpServers?.mcp_servers?.taco?.args?.includes("--eval"));

            const facts = await ws.sessionRegistry.withSession(
                first.subSessionId,
                readSessionFacts,
            );
            assert.equal(facts.runtime, "codex");
            const state = await ws.sessionRegistry.withSession(first.subSessionId, readCodexState);
            assert.equal(state?.nativeThreadId, "thread-codex-1");
            assert.equal(state?.cwd, canonicalCwd);
            assert.equal(state?.profileIdentity.includes(def.agentType), true);
            assert.equal(ws.agentSpawner.abortSubagentRun(first.subSessionId), false);

            const resumed = await ws.agentSpawner.resumeSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-2",
                subSessionId: first.subSessionId,
                prompt: "continue",
            });
            assert.equal(resumed.isError, false, resumed.resultText);
            assert.equal(resumed.resultText, "continued answer");
            assert.equal(seen.resume?.id, "thread-codex-1");
            assert.equal(seen.starts, 1);
            assert.equal(seen.resumes, 1);
        } finally {
            ws.agentSpawner.off("subagent.spawned", onSpawned);
            restore();
        }
    });

    it("inherits the current Codex model when the agent leaves model unset", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["first answer", "continued answer"], seen));
        const previous = def.codex;
        def.codex = { sandbox: "read-only", approvalPolicy: "never" };
        try {
            const parent = await seedParent("codex-parent-inherited-model");
            const first = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-inherited-model-1",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.equal(first.isError, false, first.resultText);
            assert.ok(first.subSessionId);
            assert.equal(seen.start?.model, undefined);
            assert.equal(Object.hasOwn(seen.start ?? {}, "model"), false);

            const state = await ws.sessionRegistry.withSession(first.subSessionId, readCodexState);
            assert.equal(Object.hasOwn(state?.threadOptions ?? {}, "model"), false);

            const resumed = await ws.agentSpawner.resumeSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-inherited-model-2",
                subSessionId: first.subSessionId,
                prompt: "continue",
            });
            assert.equal(resumed.isError, false, resumed.resultText);
            assert.equal(seen.resume?.options?.model, undefined);
            assert.equal(Object.hasOwn(seen.resume?.options ?? {}, "model"), false);
        } finally {
            def.codex = previous;
            restore();
        }
    });

    it("drops a blank Codex model instead of persisting it", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["answer"], seen));
        const previous = def.codex;
        def.codex = { model: " ", sandbox: "read-only", approvalPolicy: "never" };
        try {
            const parent = await seedParent("codex-parent-blank-model");
            const result = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-blank-model",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.equal(result.isError, false, result.resultText);
            assert.ok(result.subSessionId);
            assert.equal(seen.start?.model, undefined);
            const state = await ws.sessionRegistry.withSession(result.subSessionId, readCodexState);
            assert.equal(Object.hasOwn(state?.threadOptions ?? {}, "model"), false);
        } finally {
            def.codex = previous;
            restore();
        }
    });

    it("rejects a changed Codex profile without starting another thread", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["initial", "must not run"], seen));
        try {
            const parent = await seedParent("codex-parent-2");
            const first = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-3",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.ok(first.subSessionId);
            def.codex = { model: "different-model", sandbox: "read-only", approvalPolicy: "never" };
            const resumed = await ws.agentSpawner.resumeSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-4",
                subSessionId: first.subSessionId,
                prompt: "continue",
            });
            assert.equal(resumed.isError, true);
            assert.match(resumed.resultText, /profile changed/);
            assert.equal(seen.starts, 1);
            assert.equal(seen.resumes, undefined);
        } finally {
            def.codex = { model: "gpt-6", sandbox: "read-only", approvalPolicy: "never" };
            restore();
        }
    });

    it("rejects a changed role prompt on resume", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["initial", "must not run"], seen));
        const previousPrompt = def.systemPrompt;
        try {
            const parent = await seedParent("codex-parent-prompt-drift");
            const first = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-prompt-drift-1",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.ok(first.subSessionId);
            def.systemPrompt = "changed role contract";
            const resumed = await ws.agentSpawner.resumeSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-prompt-drift-2",
                subSessionId: first.subSessionId,
                prompt: "continue",
            });
            assert.equal(resumed.isError, true);
            assert.match(resumed.resultText, /profile changed/);
            assert.equal(seen.resumes, undefined);
        } finally {
            def.systemPrompt = previousPrompt;
            restore();
        }
    });

    it("registers a synchronous continuation before announcing it", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["initial", "must not run"], seen));
        try {
            const parent = await seedParent("codex-parent-abort-chat");
            const first = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-abort-spawn",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.ok(first.subSessionId);
            const onStarted = (event: {
                parentToolCallId?: string;
                subSessionId?: string;
            }): void => {
                if (event.subSessionId !== first.subSessionId) return;
                assert.equal(
                    ws.agentSpawner.abortSubagentRun(event.subSessionId ?? "", parent),
                    true,
                );
            };
            ws.agentSpawner.on("subagent.started", onStarted);
            try {
                const result = await ws.agentSpawner.chatToAgent(parent, {
                    parentToolCallId: "codex-abort-chat",
                    subSessionId: first.subSessionId,
                    prompt: "continue",
                    background: false,
                });
                assert.equal(result.status, "aborted");
                assert.equal(seen.resumes, undefined);
            } finally {
                ws.agentSpawner.off("subagent.started", onStarted);
            }
        } finally {
            restore();
        }
    });

    it("reports the Codex execution as running while the SDK stream is active", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let streamStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            streamStarted = resolve;
        });
        const seen: Parameters<typeof fakeSdk>[1] = {
            wait: gate,
            inputs: [],
            activeStreams: 0,
            maxActiveStreams: 0,
            onEvent: (event) => {
                if (event.type === "thread.started") streamStarted();
            },
        };
        const restore = installSdk(fakeSdk(["done"], seen));
        try {
            let childId: SessionId | undefined;
            const spawned = new Promise<void>((resolve) => {
                ws.agentSpawner.once("subagent.spawned", (event: { subSessionId: SessionId }) => {
                    childId = event.subSessionId;
                    resolve();
                });
            });
            const run = ws.agentSpawner.spawnSubagent({
                parentSessionId: await seedParent("codex-parent-running"),
                parentToolCallId: "codex-call-running",
                agentType: def.agentType,
                prompt: "first",
            });
            await spawned;
            await started;
            await nextImmediate();
            assert.ok(childId);
            assert.equal(ws.agentSpawner.conversation.state(childId)?.phase, "running");
            release();
            const result = await run;
            assert.equal(result.isError, false, result.resultText);
        } finally {
            restore();
        }
    });

    it("queues live messages FIFO without starting a competing SDK run", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let streamStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            streamStarted = resolve;
        });
        const seen: Parameters<typeof fakeSdk>[1] = {
            wait: gate,
            inputs: [],
            activeStreams: 0,
            maxActiveStreams: 0,
            onEvent: (event) => {
                if (event.type === "thread.started") streamStarted();
            },
        };
        const restore = installSdk(fakeSdk(["first answer", "second answer"], seen));
        try {
            const parent = await seedParent("codex-parent-live-queue");
            const launched = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-live-spawn",
                agentType: def.agentType,
                prompt: "first",
                background: true,
            });
            assert.ok(launched.subSessionId);
            await started;
            const first = await ws.agentSpawner.chatToAgent(parent, {
                parentToolCallId: "codex-live-1",
                subSessionId: launched.subSessionId,
                prompt: "second",
                background: true,
            });
            const second = await ws.agentSpawner.chatToAgent(parent, {
                parentToolCallId: "codex-live-2",
                subSessionId: launched.subSessionId,
                prompt: "third",
                background: true,
            });
            assert.equal(first.status, "queued");
            assert.equal(first.effectiveDelivery, "queued");
            assert.equal(first.runId, undefined);
            assert.equal(second.status, "queued");
            assert.equal(second.effectiveDelivery, "queued");
            assert.equal(second.runId, undefined);
            assert.equal(seen.starts, 1);
            assert.equal(seen.resumes, undefined);
            release();
            await ws.agentSpawner.whenBackgroundRunsSettle();
            ws.sessionRegistry.emit("session.idle", { sessionId: launched.subSessionId });
            for (let index = 0; index < 100 && seen.resumes !== 2; index++) {
                await delay(5);
            }
            await ws.agentSpawner.whenBackgroundRunsSettle();
            let records = await ws.sessionRegistry.withSession(launched.subSessionId, (session) =>
                readAgentMessages(session),
            );
            for (
                let index = 0;
                index < 100 && records.some((record) => record.receipt?.status === "queued");
                index++
            ) {
                await delay(5);
                records = await ws.sessionRegistry.withSession(launched.subSessionId, (session) =>
                    readAgentMessages(session),
                );
            }
            await ws.agentSpawner.whenBackgroundRunsSettle();
            assert.equal(
                seen.resumes,
                2,
                JSON.stringify({
                    records,
                    state: ws.agentSpawner.conversation.state(launched.subSessionId),
                }),
            );
            assert.equal(seen.inputs?.length, 3);
            assert.equal(seen.inputs?.[0], "first");
            assert.match(seen.inputs?.[1] ?? "", /\nsecond\n/);
            assert.match(seen.inputs?.[2] ?? "", /\nthird\n/);
            assert.equal(seen.maxActiveStreams, 1);
            assert.deepEqual(
                records.map((record) => record.receipt?.status),
                ["completed", "completed"],
            );
        } finally {
            release();
            restore();
        }
    });

    it("does not refuse a run because no OpenAI login is present", async () => {
        // The user's own Codex configuration decides: a custom provider
        // carries its own credentials, so only Codex can say whether a turn
        // authenticates. Taco must not block on its own guess.
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["answered"], seen));
        try {
            const parent = await seedParent("codex-parent-no-login");
            const result = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-no-login",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.equal(result.isError, false);
            assert.ok(result.subSessionId);
            assert.equal(seen.starts, 1);
        } finally {
            restore();
        }
    });

    it("reports an idle Codex continuation as followUp, not still queued", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["first answer", "continued answer"], seen));
        try {
            const parent = await seedParent("codex-parent-idle-chat");
            const first = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-idle-spawn",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.ok(first.subSessionId);
            const receipt = await ws.agentSpawner.chatToAgent(parent, {
                parentToolCallId: "codex-idle-chat",
                subSessionId: first.subSessionId,
                prompt: "continue",
                background: false,
            });
            assert.equal(receipt.status, "completed");
            assert.equal(receipt.effectiveDelivery, "followUp");
            assert.equal(receipt.isError, false);
        } finally {
            restore();
        }
    });

    it("fails before creating a child when the Codex cwd no longer exists", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["unused"], seen));
        const previous = def.codex;
        def.codex = {
            ...previous,
            model: previous?.model ?? "gpt-6",
            cwd: join(cwd, "missing-directory"),
        };
        try {
            const parent = await seedParent("codex-parent-3");
            const result = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-5",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.equal(result.isError, true);
            assert.equal(result.subSessionId, undefined);
            assert.match(result.resultText, /not an existing directory/);
            assert.equal(seen.starts, undefined);
        } finally {
            def.codex = previous;
            restore();
        }
    });

    it("rejects a Codex cwd outside the workspace and associated roots", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["unused"], seen));
        const outside = await mkdtemp(join(tmpdir(), "codex-outside-"));
        const previous = def.codex;
        def.codex = { ...previous, model: previous?.model ?? "gpt-6", cwd: outside };
        try {
            const parent = await seedParent("codex-parent-outside");
            const result = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-outside",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.equal(result.isError, true);
            assert.match(result.resultText, /workspace directory or one of its associated/);
            assert.equal(seen.starts, undefined);
        } finally {
            def.codex = previous;
            restore();
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("runs in the background through the shared completion path", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["background answer"], seen));
        const settled: Array<{ subSessionId?: string; runId?: string; outcome?: string }> = [];
        const onSettled = (event: { subSessionId?: string; runId?: string; outcome?: string }) =>
            settled.push(event);
        ws.agentSpawner.on("subagent.settled", onSettled);
        try {
            const parent = await seedParent("codex-parent-4");
            const launched = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-6",
                agentType: def.agentType,
                prompt: "background work",
                background: true,
            });
            assert.equal(launched.isError, false, launched.resultText);
            assert.ok(launched.subSessionId);
            assert.ok(launched.resultPath);
            await ws.agentSpawner.whenBackgroundRunsSettle();
            assert.equal(await readFile(launched.resultPath, "utf8"), "background answer");
            const state = await ws.sessionRegistry.withSession(
                launched.subSessionId,
                readCodexState,
            );
            assert.equal(state?.nativeThreadId, "thread-codex-1");
            assert.equal(ws.agentSpawner.abortSubagentRun(launched.subSessionId), false);
            assert.equal(seen.starts, 1);
            assert.equal(settled[0]?.subSessionId, launched.subSessionId);
            assert.ok(settled[0]?.runId);
            assert.equal(settled[0]?.outcome, "completed");
        } finally {
            ws.agentSpawner.off("subagent.settled", onSettled);
            restore();
        }
    });

    it("fails without creating an orphan child when the SDK is unavailable", async () => {
        const spawner = ws.agentSpawner as unknown as {
            loadCodexSdkForRun: () => Promise<LoadedCodexSdk>;
        };
        const original = spawner.loadCodexSdkForRun;
        spawner.loadCodexSdkForRun = async () => {
            throw new Error("Codex runtime is not installed");
        };
        try {
            const parent = await seedParent("codex-parent-5");
            const before = (await ws.sessionRegistry.listSessions()).length;
            const result = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-7",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.equal(result.isError, true);
            assert.equal(result.subSessionId, undefined);
            assert.match(result.resultText, /not installed/);
            assert.equal((await ws.sessionRegistry.listSessions()).length, before);
        } finally {
            spawner.loadCodexSdkForRun = original;
        }
    });

    it("rejects a deleted cwd on resume without calling the SDK", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["initial", "must not run"], seen));
        const nested = join(cwd, "codex-nested");
        await mkdir(nested);
        const spawnerWithCwds = ws.agentSpawner as unknown as {
            getAllowedCwds: () => readonly string[];
        };
        const originalAllowed = spawnerWithCwds.getAllowedCwds;
        spawnerWithCwds.getAllowedCwds = () => [cwd, nested];
        const previous = def.codex;
        def.codex = { ...previous, model: previous?.model ?? "gpt-6", cwd: nested };
        try {
            const parent = await seedParent("codex-parent-6");
            const first = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-8",
                agentType: def.agentType,
                prompt: "first",
            });
            assert.ok(first.subSessionId);
            await rm(nested, { recursive: true, force: true });
            const resumed = await ws.agentSpawner.resumeSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-9",
                subSessionId: first.subSessionId,
                prompt: "continue",
            });
            assert.equal(resumed.isError, true);
            assert.match(resumed.resultText, /not an existing directory/);
            assert.equal(seen.resumes, undefined);
        } finally {
            spawnerWithCwds.getAllowedCwds = originalAllowed;
            def.codex = previous;
            restore();
        }
    });

    it("keeps a newer controller when an older run releases its own", () => {
        const spawner = ws.agentSpawner as unknown as {
            subagentControllers: Map<
                string,
                { controller: AbortController; parentSessionId: SessionId }
            >;
            releaseController(id: string, expected?: AbortController): void;
        };
        const id = "codex-stale-controller";
        const oldController = new AbortController();
        const newController = new AbortController();
        const parent = asSessionId("codex-parent-controller");
        spawner.subagentControllers.set(id, { controller: newController, parentSessionId: parent });
        spawner.releaseController(id, oldController);
        assert.equal(spawner.subagentControllers.get(id)?.controller, newController);
        spawner.releaseController(id, newController);
        assert.equal(spawner.subagentControllers.has(id), false);
    });

    it("rejects resume when the native thread mapping is missing", async () => {
        const seen: Parameters<typeof fakeSdk>[1] = {};
        const restore = installSdk(fakeSdk(["must not run"], seen));
        const parent = await seedParent("codex-parent-7");
        const child = asSessionId("codex-child-no-state");
        const session = await ws.repo.create({ id: child, cwd }, harnessContext);
        try {
            await writeSessionFacts(session, {
                kind: "subagent",
                agentType: def.agentType,
                runtime: "codex",
                parentSessionId: parent,
                depth: 1,
            });
        } finally {
            await session.close(harnessContext);
        }
        ws.sessionRegistry.invalidateListCache();
        try {
            const resumed = await ws.agentSpawner.resumeSubagent({
                parentSessionId: parent,
                parentToolCallId: "codex-call-10",
                subSessionId: child,
                prompt: "continue",
            });
            assert.equal(resumed.isError, true);
            assert.match(resumed.resultText, /mapping was not saved/);
            assert.equal(seen.resumes, undefined);
        } finally {
            restore();
        }
    });
});
