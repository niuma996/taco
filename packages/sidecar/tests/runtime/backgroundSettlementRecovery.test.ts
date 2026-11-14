import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../src/agents/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { BackgroundSubagentCoordinator } from "../../src/runtime/subagent/backgroundSubagentCoordinator.ts";
import type { AgentEngine } from "../../src/runtime/subagent/engines/types.ts";
import {
    addPendingSubagentResult,
    readPendingSubagentResults,
} from "../../src/runtime/subagent/subagentPending.ts";
import { SubagentRunLifecycle } from "../../src/runtime/subagent/subagentRunLifecycle.ts";
import type { SubagentRunResult } from "../../src/runtime/subagent/subagentRunner.ts";
import { WorkService } from "../../src/work/workService.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

const definition: AgentDefinition = {
    agentType: "explorer",
    description: "Search a workspace",
    systemPrompt: "Explore",
    source: "builtin",
    filePath: "/agents/explorer.md",
};

type Prompt = (text: string) => Promise<unknown>;

async function fixture(
    t: TestContext,
    execute: () => Promise<SubagentRunResult>,
): Promise<{
    parent: ReturnType<typeof asSessionId>;
    child: ReturnType<typeof asSessionId>;
    ws: ReturnType<typeof createTestWorkspace>["ws"];
    service: WorkService;
    coordinator: BackgroundSubagentCoordinator;
}> {
    const { ws, cwd, sessionsRoot, cleanup } = createTestWorkspace({
        prefix: "background-settlement-recovery",
    });
    const parent = asSessionId("settlement-parent");
    const child = asSessionId("settlement-child");
    for (const id of [parent, child]) {
        const session = await ws.repo.create({ id, cwd }, harnessContext);
        await session.close(harnessContext);
    }

    const service = new WorkService({
        root: join(cwd, "work"),
        instanceId: "settlement-test-instance",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 1000,
            getDeliveryBinding: () => "binding",
        },
        resolveRoute: () => undefined,
    });
    const lifecycle = new SubagentRunLifecycle();
    const engine: AgentEngine = {
        runtime: "standard",
        capabilities: { forkContext: true, delivery: "nativeQueue", workLane: true },
        preflight: async () => {},
        run: execute,
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
        workHooks: service,
        execution: {
            execute,
            resume: execute,
            track: (_parent, _call, run) => run(),
        },
        events: {
            settleChat: () => false,
            emit: () => {},
        },
    });
    t.after(async () => {
        coordinator.dispose();
        await coordinator.whenBackgroundRunsSettle();
        service.stop();
        await cleanup();
    });
    return { parent, child, ws, service, coordinator };
}

function attachPrompt(
    t: TestContext,
    ws: ReturnType<typeof createTestWorkspace>["ws"],
    calls: string[],
) {
    let prompt: Prompt | undefined;
    t.mock.method(
        ws.sessionRegistry,
        "getAttached",
        () =>
            (prompt ? { prompt } : undefined) as unknown as ReturnType<
                typeof ws.sessionRegistry.getAttached
            >,
    );
    return (handler: Prompt): void => {
        prompt = async (text) => {
            calls.push(text);
            return handler(text);
        };
    };
}

async function launch(
    coordinator: BackgroundSubagentCoordinator,
    parent: ReturnType<typeof asSessionId>,
    child: ReturnType<typeof asSessionId>,
    toolCallId: string,
) {
    assert.equal(coordinator.reserve(toolCallId), undefined);
    const receipt = await coordinator.launch(
        {
            parentSessionId: parent,
            parentToolCallId: toolCallId,
            childSessionId: child,
            agentType: definition.agentType,
            prompt: "Search",
            tools: [],
        },
        definition,
        "Find the actual result",
    );
    await coordinator.whenBackgroundRunsSettle();
    return receipt;
}

test("retries an execution error settlement before admitting exactly one parent notice", async (t) => {
    const { parent, child, ws, service, coordinator } = await fixture(t, async () => {
        throw new Error("execution exploded");
    });
    const prompts: string[] = [];
    const setPrompt = attachPrompt(t, ws, prompts);
    let settleCalls = 0;
    const settle = service.controller.settle.bind(service.controller);
    service.controller.settle = async (args) => {
        settleCalls++;
        if (settleCalls === 1) throw new Error("settlement disk unavailable");
        return settle(args);
    };

    await launch(coordinator, parent, child, "error-call");
    const pending = await ws.sessionRegistry.withSession(parent, readPendingSubagentResults);
    assert.equal(pending["error-call"]?.settlementPending, true);
    assert.equal(pending["error-call"]?.settlementText, "execution exploded");
    assert.equal(pending["error-call"]?.attemptId !== undefined, true);
    const workId = pending["error-call"]?.workId;
    assert.ok(workId);
    assert.equal(prompts.length, 0);

    setPrompt(async () => ({ role: "assistant", content: [] }));
    await coordinator.flush(parent);
    assert.equal(settleCalls, 2);
    assert.equal(prompts.length, 1);
    const work = await service.store.get(workId);
    assert.equal(work?.status, "failed");
    assert.equal(work?.attempt.attemptId, pending["error-call"]?.attemptId);
    assert.ok(work?.result);
    const stored = await service.store.readResult(
        workId,
        work.result.resultId,
        work.result.checksum,
    );
    assert.equal(stored?.text, "execution exploded");
    assert.deepEqual(await ws.sessionRegistry.withSession(parent, readPendingSubagentResults), {});
});

test("recovers settlement text when the result file is unreadable", async (t) => {
    const resultText = "recoverable result body";
    const { parent, child, ws, service, coordinator } = await fixture(t, async () => ({
        subSessionId: child,
        resultText,
        isError: false,
    }));
    const prompts: string[] = [];
    const setPrompt = attachPrompt(t, ws, prompts);
    let settleCalls = 0;
    const settle = service.controller.settle.bind(service.controller);
    service.controller.settle = async (args) => {
        settleCalls++;
        if (settleCalls === 1) throw new Error("settlement snapshot unavailable");
        return settle(args);
    };

    const receipt = await launch(coordinator, parent, child, "missing-file-call");
    await rm(receipt.resultPath, { force: true });
    const pending = await ws.sessionRegistry.withSession(parent, readPendingSubagentResults);
    assert.equal(pending["missing-file-call"]?.settlementPending, true);
    assert.equal(pending["missing-file-call"]?.settlementText, resultText);

    setPrompt(async () => ({ role: "assistant", content: [] }));
    await coordinator.flush(parent);
    assert.equal(settleCalls, 2);
    assert.equal(
        (await service.store.get(pending["missing-file-call"]?.workId ?? ""))?.status,
        "completed",
    );
    assert.equal(prompts.length, 1);
    assert.equal(await readFile(receipt.resultPath, "utf8"), resultText);
    assert.deepEqual(await ws.sessionRegistry.withSession(parent, readPendingSubagentResults), {});
});

test("uses the committed Work snapshot when a pending settlement points at a stale file", async (t) => {
    const resultText = "authoritative result body";
    const { parent, child, ws, service, coordinator } = await fixture(t, async () => ({
        subSessionId: child,
        resultText,
        isError: false,
    }));
    const prompts: string[] = [];
    const setPrompt = attachPrompt(t, ws, prompts);
    const receipt = await launch(coordinator, parent, child, "committed-call");
    const pending = await ws.sessionRegistry.withSession(parent, readPendingSubagentResults);
    const entry = pending["committed-call"];
    assert.ok(entry?.workId);
    assert.ok(entry?.attemptId);
    await ws.sessionRegistry.withSession(parent, async (session) => {
        await addPendingSubagentResult(session, {
            ...entry,
            settlementPending: true,
            resultPath: join("/unreadable", "stale-result.txt"),
            settlementText: "stale settlement body",
        });
    });

    let settleCalls = 0;
    const settle = service.controller.settle.bind(service.controller);
    service.controller.settle = async (args) => {
        settleCalls++;
        return settle(args);
    };
    setPrompt(async () => ({ role: "assistant", content: [] }));
    await coordinator.flush(parent);

    assert.equal(settleCalls, 0);
    assert.equal(prompts.length, 1);
    assert.match(
        prompts[0] ?? "",
        new RegExp(receipt.resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(prompts[0] ?? "", /stale-result\.txt/);
    assert.deepEqual(await ws.sessionRegistry.withSession(parent, readPendingSubagentResults), {});
});
