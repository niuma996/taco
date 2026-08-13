/**
 * typedRpc factory unit tests — verifies every typed method forwards the
 * (method, workspace, params) triple correctly. In the client-side typecheck
 * blind spot (no tsc on Node), this is the earliest place to catch adapter
 * reordering bugs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RPC } from "../rpcMethods.js";
import { createTypedRpc, type RpcDispatch } from "../typedRpc.js";

interface Call {
    method: string;
    workspace?: string;
    params: unknown;
    process: boolean;
}

function mock(): { dispatch: RpcDispatch; calls: Call[] } {
    const calls: Call[] = [];
    const dispatch: RpcDispatch = {
        call: async (method, workspace, params) => {
            calls.push({ method, workspace, params, process: false });
            return undefined as never;
        },
        callProcess: async (method, params) => {
            calls.push({ method, params, process: true });
            return undefined as never;
        },
    };
    return { dispatch, calls };
}

test("sessionCreate 用统一 object 形状,workspace 从 args 取", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionCreate({ workspace: "/w", initialPrompt: "hi" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, RPC.sessionCreate);
    assert.equal(calls[0].workspace, "/w");
    assert.equal(calls[0].process, false);
    assert.deepEqual(calls[0].params, { workspace: "/w", initialPrompt: "hi" });
});

test("sessionCreate 透传 thinkingLevel", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionCreate({
        workspace: "/w",
        sessionId: "s1",
        initialPrompt: "hi",
        thinkingLevel: "low",
    });
    assert.deepEqual(calls[0].params, {
        workspace: "/w",
        sessionId: "s1",
        initialPrompt: "hi",
        thinkingLevel: "low",
    });
});

test("settingsGet 走 callProcess,无 workspace", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).settingsGet();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, RPC.settingsGet);
    assert.equal(calls[0].process, true);
    assert.equal(calls[0].workspace, undefined);
});

test("extensionsStatus 走 callProcess,无 workspace", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).extensionsStatus();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, RPC.extensionsStatus);
    assert.equal(calls[0].process, true);
    assert.equal(calls[0].workspace, undefined);
});

test("settingsWrite 走 callProcess,params 包装成 { global }", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).settingsWrite({ global: { defaultModel: "x" } });
    assert.equal(calls[0].method, RPC.settingsWrite);
    assert.equal(calls[0].process, true);
    assert.deepEqual(calls[0].params, { global: { defaultModel: "x" } });
});

test("workspaceEnsure 走 call,workspace 到位", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).workspaceEnsure("/w");
    assert.equal(calls[0].method, RPC.workspaceEnsure);
    assert.equal(calls[0].process, false);
    assert.equal(calls[0].workspace, "/w");
    assert.deepEqual(calls[0].params, { cwd: "/w" });
});

test("workspaceDispose 走 call", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).workspaceDispose("/w");
    assert.equal(calls[0].method, RPC.workspaceDispose);
    assert.equal(calls[0].workspace, "/w");
    assert.deepEqual(calls[0].params, { cwd: "/w" });
});

test("sessionList 把 workspace 放进 params", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionList("/w");
    assert.equal(calls[0].method, RPC.sessionList);
    assert.equal(calls[0].workspace, "/w");
    assert.deepEqual(calls[0].params, { workspace: "/w" });
});

test("sessionAttach 透传 thinkingLevel opts", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionAttach("/w", "s1", { thinkingLevel: "high" });
    assert.equal(calls[0].method, RPC.sessionAttach);
    assert.equal(calls[0].workspace, "/w");
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1", thinkingLevel: "high" });
});

test("sessionAttach 不传 opts 时不包含 thinkingLevel", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionAttach("/w", "s1");
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1" });
});

test("sessionPrompt 三个参数正确填进 params", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionPrompt("/w", "s1", "hello");
    assert.equal(calls[0].method, RPC.sessionPrompt);
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1", text: "hello" });
});

test("sessionPrompt 透传 images,images 为空数组时不带该字段", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionPrompt("/w", "s1", "hi", [
        { type: "image", data: "AAA", mimeType: "image/png" },
    ]);
    assert.deepEqual(calls[0].params, {
        workspace: "/w",
        sessionId: "s1",
        text: "hi",
        images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });

    // Empty array → omit images field (avoids triggering "has image but empty" branch in the protocol layer)
    const { dispatch: d2, calls: c2 } = mock();
    await createTypedRpc(d2).sessionPrompt("/w", "s1", "hi", []);
    assert.deepEqual(c2[0].params, { workspace: "/w", sessionId: "s1", text: "hi" });
});

test("sessionSetModel 透传 provider/modelId", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionSetModel("/w", "s1", "anthropic", "claude-x");
    assert.deepEqual(calls[0].params, {
        workspace: "/w",
        sessionId: "s1",
        provider: "anthropic",
        modelId: "claude-x",
    });
});

test("sessionListModels provider 可选,undefined 也透传", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionListModels("/w");
    assert.equal(calls[0].method, RPC.sessionListModels);
    assert.deepEqual(calls[0].params, { workspace: "/w", provider: undefined });
});

test("sessionDelete workspace + sessionId", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionDelete("/w", "s1");
    assert.equal(calls[0].method, RPC.sessionDelete);
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1" });
});

test("sessionSetThinkingLevel 透传 level", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionSetThinkingLevel("/w", "s1", "max");
    assert.equal(calls[0].method, RPC.sessionSetThinkingLevel);
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1", level: "max" });
});

test("sessionAbort workspace + sessionId", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionAbort("/w", "s1");
    assert.equal(calls[0].method, RPC.sessionAbort);
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1" });
});

test("sessionCompact 携带 customInstructions 时写入 RPC 帧", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionCompact("/w", "s1", "be terse");
    assert.equal(calls[0].method, RPC.sessionCompact);
    assert.deepEqual(calls[0].params, {
        workspace: "/w",
        sessionId: "s1",
        customInstructions: "be terse",
    });
});

test("sessionCompact 省略 customInstructions 时帧内不出现该字段", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionCompact("/w", "s1");
    assert.equal(calls[0].method, RPC.sessionCompact);
    const params = calls[0].params as Record<string, unknown>;
    assert.equal(params.workspace, "/w");
    assert.equal(params.sessionId, "s1");
    assert.equal("customInstructions" in params, false);
});

test("sessionContextInfo 透传 workspace + sessionId", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionContextInfo("/w", "s1");
    assert.equal(calls[0].method, RPC.sessionContextInfo);
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1" });
});
