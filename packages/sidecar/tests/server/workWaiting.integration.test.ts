import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { asSessionId, asWorkspaceId, type RpcRequest } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { createJobDispatcher } from "../../src/scheduler/dispatcher.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { createAskUserTool } from "../../src/tools/askUser.ts";
import { WorkService } from "../../src/work/workService.ts";
import { isTerminal } from "../../src/work/workTypes.ts";

it("runs a scheduled question through RPC and retries the same answer without another attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-wait-rpc-"));
    const provider = fauxProvider({ provider: "waiting-test", tokensPerSecond: 0 } as never);
    const questions = [
        {
            question: "Choose an approach?",
            header: "Approach",
            multiSelect: false,
            options: [
                { label: "A", description: "First" },
                { label: "B", description: "Second" },
            ],
        },
    ];
    provider.setResponses([
        fauxAssistantMessage([
            { type: "toolCall", id: "q-1", name: "askUser", arguments: { questions } },
        ]),
        fauxAssistantMessage([fauxText("Work finished using A")]),
        fauxAssistantMessage([fauxText("Work finished using A")]),
        fauxAssistantMessage([fauxText("Work finished using A")]),
    ] as never);
    const models = createModels();
    models.setProvider(provider.provider);
    const workspace = asWorkspaceId(root);
    const ws = new WorkspaceRuntime({
        cwd: workspace,
        sessionsRoot: join(root, "sessions"),
        models,
        defaultModel: provider.getModel(),
        providerKeyStore: new ProviderKeyStore({}),
        tools: [createAskUserTool()],
        memoryEnabled: false,
    });
    const work = new WorkService({
        root: join(root, "work"),
        instanceId: "test",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 2000,
        },
        resolveRoute: () => undefined,
    });
    const host = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    host.ensureWorkspace = async () => ws;
    const dispatchRpc = async (request: RpcRequest) => {
        if (request.method === "session.create") {
            const params = request.params as { sessionId: string };
            const session = await ws.repo.create(
                { id: params.sessionId, cwd: root },
                harnessContext,
            );
            await session.close(harnessContext);
            ws.invalidateListCache();
        }
        // Use the production dispatcher for session.prompt and submitAnswers while ensuring Work ownership.
        const reg = await import("../../src/server/methodRegistry.ts");
        if (request.method === "session.create") {
            const params = request.params as { sessionId: string; initialPrompt: string };
            const attached = await ws.attach(asSessionId(params.sessionId));
            return {
                id: request.id,
                ok: true as const,
                result: {
                    sessionId: params.sessionId,
                    assistantMessage: await attached.prompt(params.initialPrompt),
                },
            };
        }
        const method = reg.getRegisteredMethod(request.method);
        assert.ok(method);
        return {
            id: request.id,
            ok: true as const,
            result: await method.handler({
                id: request.id,
                cwd: workspace,
                workspace: ws,
                server: {
                    work,
                    awaitCompactionEnd: async () => true,
                    isCompressing: () => false,
                } as never,
                params: request.params,
            }),
        };
    };
    try {
        const fire = await createJobDispatcher(() => ({ dispatchRpc }), { work })(
            {
                id: "daily",
                name: "Question",
                command: "agent.invoke",
                args: { workspace: root, prompt: "Ask for the approach" },
                schedule: { kind: "interval", ms: 60000 },
                sessionStrategy: "new",
                enabled: true,
                run_on_startup: false,
                history: [],
            },
            { fireId: "f", onWork: () => {} },
        );
        assert.ok(fire?.workId);
        const before = await work.store.get(fire.workId);
        assert.ok(before);
        assert.equal(before.status, "waiting");
        assert.equal(isTerminal(before.status), false);
        assert.equal(before.waiting?.toolCallId, "q-1");
        await dispatchRpc({
            id: "answer",
            method: "session.submitAnswers",
            params: {
                workspace: asWorkspaceId(`${root}/./`),
                sessionId: before.parentSessionId,
                toolCallId: "q-1",
                toolName: "askUser",
                answers: { "Choose an approach?": "A" },
            },
        });
        const after = await work.store.get(fire.workId);
        assert.ok(after);
        assert.equal(after.status, "completed");
        assert.notEqual(after.attempt.attemptId, before.attempt.attemptId);
        assert.match((await work.get(fire.workId)).resultText ?? "", /Work finished using A/);
        await dispatchRpc({
            id: "answer-retry",
            method: "session.submitAnswers",
            params: {
                workspace,
                sessionId: before.parentSessionId,
                toolCallId: "q-1",
                answers: { "Choose an approach?": "A" },
            },
        });
        assert.equal(
            (await work.store.get(fire.workId))?.attempt.attemptId,
            after.attempt.attemptId,
        );
        await assert.rejects(
            dispatchRpc({
                id: "stale",
                method: "session.submitAnswers",
                params: {
                    workspace,
                    sessionId: before.parentSessionId,
                    toolCallId: "q-1",
                    answers: { "Choose an approach?": "B" },
                },
            }),
            /different answers/,
        );
    } finally {
        work.stop();
        await host.stop();
        await ws.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
