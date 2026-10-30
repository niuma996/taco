import assert from "node:assert/strict";
import { test } from "node:test";
import {
    asSessionId,
    asToolCallId,
    asWorkspaceId,
    ErrorCodes,
    RPC,
    type RpcRequest,
    readValidationIssues,
    SIDECAR_PROTOCOL_VERSION,
} from "@taco-ai/protocol";
import { createTypedRpc, describeRpcError, type RpcDispatch } from "@taco-ai/shared";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { SidecarServer } from "../../src/server/server.ts";

test("session facade round-trips through JSON, server schemas, and the rename handler", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const renames: Array<[string, string]> = [];
    let resolutions = 0;
    server.ensureWorkspace = async () => {
        resolutions++;
        return {
            renameSession: async (id: string, name: string) => {
                renames.push([id, name]);
            },
        } as unknown as WorkspaceRuntime;
    };
    const dispatch: RpcDispatch = {
        call: async <P, R>(method: string, _workspace: unknown, params: P): Promise<R> => {
            const request = JSON.parse(
                JSON.stringify({ id: "rename", method, params }),
            ) as RpcRequest;
            const response = await server.dispatchRpc(request);
            if (!response.ok) throw new Error(response.error.code);
            return JSON.parse(JSON.stringify(response.result)) as R;
        },
        callProcess: async () => {
            throw new Error("session must use workspace routing");
        },
    };
    const client = createTypedRpc(dispatch);
    const workspace = asWorkspaceId("/w");
    const sessionId = asSessionId("s");
    assert.deepEqual(await client.sessionRename({ workspace, sessionId, name: "" }), {
        renamed: true,
    });
    assert.deepEqual(renames, [["s", ""]]);
    // Exercise malformed JavaScript input, which bypasses TypeScript.
    await assert.rejects(
        client.sessionRename({ workspace, sessionId, name: 42 as never }),
        /invalid_params/,
    );
    assert.equal(resolutions, 1, "schema rejection must precede workspace/handler access");
});

test("session optional fields reach server validation without being lost or coerced", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const received: RpcRequest[] = [];
    // Stop at runtime resolution: no model or transcript is needed to verify the gate.
    server.ensureWorkspace = async () => {
        throw new Error("contract gate passed");
    };
    const dispatch: RpcDispatch = {
        call: async <P, R>(method: string, _workspace: unknown, params: P): Promise<R> => {
            const request = JSON.parse(
                JSON.stringify({ id: String(received.length), method, params }),
            );
            received.push(request);
            const response = await server.dispatchRpc(request);
            assert.equal(response.ok, false);
            if (!response.ok) {
                assert.equal(response.error.code, ErrorCodes.Internal);
                assert.match(response.error.message, /contract gate passed/);
            }
            return undefined as R;
        },
        callProcess: async () => {
            throw new Error("wrong route");
        },
    };
    const client = createTypedRpc(dispatch);
    const workspace = asWorkspaceId("/w");
    const id = asSessionId("s");
    await client.sessionCreate({ workspace });
    await client.sessionAttach({ workspace, sessionId: id, thinkingLevel: "max" });
    await client.sessionPrompt({
        workspace,
        sessionId: id,
        text: "",
        images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
        uiLocale: "zh",
        model: { provider: "p", id: "m" },
    });
    assert.equal(received[0].method, RPC.sessionCreate);
    assert.deepEqual(received[0].params, { workspace: "/w" });
    assert.deepEqual(received[1].params, { workspace: "/w", sessionId: "s", thinkingLevel: "max" });
    assert.deepEqual(received[2].params, {
        workspace: "/w",
        sessionId: "s",
        text: "",
        images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
        uiLocale: "zh",
        model: { provider: "p", id: "m" },
    });
});

test("no-param facade calls survive JSON omission at the real server gate", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const dispatch: RpcDispatch = {
        call: async () => {
            throw new Error("wrong route");
        },
        callProcess: async <P, R>(method: string, params: P): Promise<R> => {
            const request = JSON.parse(JSON.stringify({ id: "list", method, params }));
            assert.equal("params" in request, false);
            const response = await server.dispatchRpc(request);
            assert.equal(response.ok, true);
            return (response.ok ? response.result : undefined) as R;
        },
    };
    assert.deepEqual(await createTypedRpc(dispatch).workspaceList(), []);
});

test("every facade method serializes a payload accepted by its registered schema", async () => {
    const { rpcSchemas, rpcContract } = await import("@taco-ai/protocol");
    const { Value } = await import("typebox/value");
    const keys = Object.keys(rpcContract) as Array<keyof typeof rpcContract>;
    const checked = new Set<string>();
    function validate(method: string, params: unknown, process: boolean) {
        const key = keys.find((key) => RPC[key] === method);
        assert.ok(key, method);
        assert.equal(rpcContract[key].scope, process ? "process" : "workspace", method);
        const wire = JSON.parse(JSON.stringify({ method, params }));
        assert.deepEqual(Value.Errors(rpcSchemas[key], wire.params), [], method);
        checked.add(method);
    }
    const client = createTypedRpc({
        call: async (method, _workspace, params) => {
            validate(method, params, false);
            return undefined as never;
        },
        callProcess: async (method, params) => {
            validate(method, params, true);
            return undefined as never;
        },
    });
    const workspace = asWorkspaceId("/w");
    const id = asSessionId("s");
    await client.initialize({ protocolVersion: SIDECAR_PROTOCOL_VERSION, clientCapabilities: {} });
    await client.workspaceList();
    await client.sessionList({ workspace });
    await client.sessionCreate({ workspace });
    await client.sessionAttach({ workspace, sessionId: id });
    await client.sessionDetach({ workspace, sessionId: id });
    await client.sessionDelete({ workspace, sessionId: id });
    await client.sessionRename({ workspace, sessionId: id, name: "renamed" });
    await client.sessionHistory({ workspace, sessionId: id });
    await client.sessionEventsGet({ workspace, sessionId: id, afterSeq: 0 });
    await client.sessionSnapshotGet({ workspace, sessionId: id });
    await client.sessionTasksGet({ workspace, sessionId: id });
    await client.sessionTaskHistoryGet({ workspace, sessionId: id, listId: "list" });
    await client.sessionPlanStateGet({ workspace, sessionId: id });
    await client.sessionPrompt({ workspace, sessionId: id, text: "hello" });
    await client.sessionSteer({ workspace, sessionId: id, text: "redirect" });
    await client.sessionFollowUp({ workspace, sessionId: id, text: "later" });
    await client.sessionCancelQueued({ workspace, sessionId: id, entryId: "entry" });
    await client.sessionSubmitAnswers({
        workspace,
        sessionId: id,
        toolCallId: asToolCallId("tool"),
        answers: { q: "answer" },
    });
    await client.sessionAbort({ workspace, sessionId: id });
    await client.subagentAbort({ workspace, subSessionId: id });
    await client.sessionSetModel({
        workspace,
        sessionId: id,
        provider: "provider",
        modelId: "model",
    });
    await client.sessionListModels({ workspace });
    await client.providersList({ workspace });
    await client.providersRevealKey({ workspace, providerId: "provider" });
    await client.sessionSetThinkingLevel({ workspace, sessionId: id, level: "max" });
    await client.sessionCompact({ workspace, sessionId: id, customInstructions: "brief" });
    await client.sessionContextInfo({ workspace, sessionId: id });
    await client.attachmentStage({ workspace, path: "/tmp/a.pdf" });
    await client.attachmentStage({ workspace, name: "a.txt", data: "AA", mimeType: "text/plain" });
    await client.sessionPrompt({
        workspace,
        sessionId: id,
        text: "with files",
        uiLocale: "zh",
        attachments: ["a"],
    });
    await client.sessionSteer({ workspace, sessionId: id, text: "with files", attachments: ["a"] });
    await client.sessionFollowUp({
        workspace,
        sessionId: id,
        text: "with files",
        attachments: ["a"],
    });
    await client.commandPermissionResolve({
        workspace,
        requestId: "request",
        approved: true,
        scope: "once",
    });
    await client.workspaceEnsure({ cwd: workspace });
    await client.workspaceDispose({ cwd: workspace });
    await client.workspaceAssociationsGet({ key: { scope: "workspace", id: workspace } });
    await client.workspaceAssociationsSet({
        key: { scope: "workspace", id: workspace },
        roots: ["/other"],
    });
    await client.workspaceAssociationsResolve({ workspace });
    await client.settingsGet();
    await client.settingsWrite({ global: { defaultModel: "m" } });
    await client.extensionsStatus();
    await client.channelsList();
    await client.channelsListConversations({});
    await client.channelsCreate({ name: "wechat" });
    await client.channelsBind({ channelId: "c", creds: { botId: "b", secret: "s" } });
    await client.channelsSubmitVerifyCode({ requestId: "r", code: "123" });
    await client.channelsUnbind({ channelId: "c" });
    await client.channelsRetry({ channelId: "c" });
    await client.imPolicyGet({ channelId: "c" });
    await client.imPolicySetChannelDefault({ channelId: "c", patch: { tools: { shell: null } } });
    await client.imPolicySetChatOverride({ channelId: "c", peerId: "p", chatId: "t", patch: {} });
    await client.imPolicyClearChatOverride({ channelId: "c", peerId: "p", chatId: "t" });
    await client.providerListModels({ providerId: "p" });
    await client.providerTestConnection({
        baseUrl: "https://example.com",
        api: "anthropic",
        apiKey: "",
        modelId: "m",
    });
    await client.toolsList({ workspace });
    await client.agentsList({ workspace });
    await client.agentsContent({ workspace, agentType: "reviewer" });
    await client.agentsWrite({
        workspace,
        agentType: "reviewer",
        description: "Review",
        maxTurns: 10,
        systemPrompt: "",
    });
    await client.agentsDelete({ workspace, agentType: "reviewer" });
    await client.skillsList({ workspace });
    await client.skillContent({ workspace, filePath: "/w/SKILL.md" });
    await client.checkpointsList({ workspace });
    await client.checkpointsRestore({ workspace, checkpointId: "cp", sessionId: id });
    await client.memoryList({ workspace });
    await client.memoryWrite({ workspace, content: "", baseHash: "hash" });
    await client.memoryDeleteTopic({ workspace, id: "topic", expectedContent: "" });
    await client.memoryRestoreTopic({ workspace, id: "topic" });
    await client.memoryDreamRun({ workspace });
    await client.memoryDreamApply({ workspace, previewId: "preview" });
    await client.memoryDreamDiscard({ workspace });
    await client.memoryDreamUndo({ workspace, reportId: "report" });
    await client.memoryUpsert({
        workspace,
        action: "add",
        id: "topic",
        name: "Topic",
        type: "project",
        content: "x",
    });
    await client.mcpListServers({});
    await client.mcpGetConfig({ id: "srv" });
    await client.mcpCreateConfig({ config: { id: "srv", transport: "stdio", command: "run" } });
    await client.mcpUpdateConfig({ id: "srv", patch: { enabled: false } });
    await client.mcpDeleteConfig({ id: "srv" });
    const expected = keys
        .filter((key) => !key.startsWith("jobs") && key !== "configPatch")
        .map((key) => RPC[key])
        .sort();
    assert.deepEqual([...checked].sort(), expected);
});

test("a schema rejection names the offending field on the wire", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const response = await server.dispatchRpc({
        id: "bad-rename",
        method: RPC.sessionRename,
        params: { workspace: "/w", sessionId: "s", name: 42 },
    });
    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.code, ErrorCodes.InvalidParams);
    const issues = readValidationIssues(response.error.data);
    assert.ok(issues, "a schema failure must carry the field paths");
    assert.ok(
        issues.some((issue) => issue.path.includes("name")),
        `expected the offending field in ${JSON.stringify(issues)}`,
    );
    // The client renders exactly these issues into the message it shows.
    assert.match(
        describeRpcError(response.error.code, response.error.message, response.error.data),
        /\/name/,
    );
});
