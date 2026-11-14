import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type TestContext, test } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { BackgroundSubagentCoordinator } from "../../src/runtime/subagent/backgroundSubagentCoordinator.ts";
import type { AgentEngine } from "../../src/runtime/subagent/engines/types.ts";
import { readPendingSubagentResults } from "../../src/runtime/subagent/subagentPending.ts";
import { SubagentRunLifecycle } from "../../src/runtime/subagent/subagentRunLifecycle.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

const definition: AgentDefinition = {
    agentType: "explorer",
    description: "Search a workspace",
    systemPrompt: "Explore",
    source: "builtin",
    filePath: "/agents/explorer.md",
};
const parent = asSessionId("parent");
const child = asSessionId("child");

async function fixture(t: TestContext) {
    const { ws, cwd, sessionsRoot, cleanup } = createTestWorkspace();
    const lifecycle = new SubagentRunLifecycle();
    for (const id of [parent, child]) {
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        await session.close(harnessContext);
    }
    const result = { subSessionId: child, resultText: "found it", isError: false };
    const engine: AgentEngine = {
        runtime: "standard",
        capabilities: { forkContext: true, delivery: "nativeQueue", workLane: true },
        preflight: async () => {},
        run: async () => result,
    };
    const events: string[] = [];
    const baseline = {
        attached: ws.sessionRegistry.listenerCount("session.attached"),
        idle: ws.sessionRegistry.listenerCount("session.idle"),
    };
    const coordinator = new BackgroundSubagentCoordinator({
        sessionRegistry: ws.sessionRegistry,
        conversation: ws.agentSpawner.conversation,
        runLifecycle: lifecycle,
        engines: {
            standard: engine,
            "claude-code": { ...engine, runtime: "claude-code" },
            codex: { ...engine, runtime: "codex" },
        },
        sessionsRoot,
        workspaceKey: ws.workspaceKey,
        executeSubagentSession: async () => result,
        runResume: async () => result,
        trackInFlight: (_parent, _call, run) => run(),
        hasChatRun: () => false,
        settleChatRun: () => {},
        emit: (event) => events.push(event),
    });
    t.after(async () => {
        coordinator.dispose();
        await coordinator.whenBackgroundRunsSettle();
        await cleanup();
    });
    return { ws, coordinator, lifecycle, baseline, events };
}

test("background coordinator releases only its own retry listeners on dispose", async (t) => {
    const { ws, coordinator, baseline } = await fixture(t);
    assert.equal(ws.sessionRegistry.listenerCount("session.attached"), baseline.attached + 1);
    assert.equal(ws.sessionRegistry.listenerCount("session.idle"), baseline.idle + 1);
    coordinator.dispose();
    coordinator.dispose();
    assert.equal(ws.sessionRegistry.listenerCount("session.attached"), baseline.attached);
    assert.equal(ws.sessionRegistry.listenerCount("session.idle"), baseline.idle);
});

test("background coordinator persists the result and retries a failed parent notice", async (t) => {
    const { ws, coordinator, lifecycle, events } = await fixture(t);
    let rejectDelivery = true;
    let attempts = 0;
    t.mock.method(
        ws.sessionRegistry,
        "getAttached",
        () =>
            ({
                prompt: async () => {
                    attempts++;
                    assert.deepEqual(events, ["subagent.settled"]);
                    const pending = await ws.sessionRegistry.withSession(
                        parent,
                        readPendingSubagentResults,
                    );
                    assert.equal(pending.call?.outcome, "completed");
                    assert.ok(pending.call?.resultPath);
                    assert.equal(await readFile(pending.call.resultPath, "utf8"), "found it");
                    if (rejectDelivery) throw new Error("parent unavailable");
                },
            }) as unknown as ReturnType<typeof ws.sessionRegistry.getAttached>,
    );
    assert.equal(coordinator.reserve("call"), undefined);
    const receipt = await coordinator.launch(
        {
            parentSessionId: parent,
            parentToolCallId: "call",
            childSessionId: child,
            agentType: definition.agentType,
            prompt: "Search",
            tools: [],
        },
        definition,
    );
    assert.equal(receipt.background, true);
    await coordinator.whenBackgroundRunsSettle();
    assert.equal(await readFile(receipt.resultPath, "utf8"), "found it");
    assert.equal(coordinator.reserve("call"), undefined);
    coordinator.release("call");
    assert.equal(lifecycle.abort(child), false);
    assert.equal(attempts, 1);
    rejectDelivery = false;
    await coordinator.flush(parent);
    await coordinator.flush(parent);
    assert.equal(attempts, 2);
    assert.deepEqual(await ws.sessionRegistry.withSession(parent, readPendingSubagentResults), {});
});
