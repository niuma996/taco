/**
 * typedRpc factory unit tests — the generated surface covers every contract
 * row, routes by scope, and passes params through untouched; the turn
 * overrides drop empty optional fields.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { asSessionId, asWorkspaceId, type RpcContractKey, rpcContract } from "@taco-ai/protocol";
import type { RpcDispatch } from "../contractDispatch.js";
import { RPC } from "../rpcMethods.js";
import { createTypedRpc } from "../typedRpc.js";

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

const TYPED_KEYS = (Object.keys(rpcContract) as RpcContractKey[]).filter(
    (key) => !key.startsWith("jobs") && key !== "configPatch",
);

test("每个 contract 方法都生成,按 scope 路由并原样透传 params", async () => {
    const { dispatch, calls } = mock();
    const rpc = createTypedRpc(dispatch) as unknown as Record<
        string,
        (p: unknown) => Promise<unknown>
    >;
    assert.deepEqual(Object.keys(rpc).sort(), [...TYPED_KEYS].sort());
    const turnKeys = new Set(["sessionPrompt", "sessionSteer", "sessionFollowUp"]);
    for (const key of TYPED_KEYS) {
        if (turnKeys.has(key)) continue;
        const params = { workspace: "/w", cwd: "/c", marker: key };
        calls.length = 0;
        await rpc[key](params);
        assert.equal(calls.length, 1, key);
        assert.equal(calls[0].method, RPC[key], key);
        assert.equal(calls[0].params, params, key);
        const isProcess = rpcContract[key].scope === "process";
        assert.equal(calls[0].process, isProcess, key);
        const expectedRoute = isProcess
            ? undefined
            : key === "workspaceEnsure" || key === "workspaceDispose"
              ? "/c"
              : "/w";
        assert.equal(calls[0].workspace, expectedRoute, key);
    }
});

test("无参方法不传参数时帧内 params 为 undefined", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).settingsGet();
    assert.deepEqual(calls[0], { method: RPC.settingsGet, params: undefined, process: true });
});

test("sessionPrompt 三个参数正确填进 params", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionPrompt({
        workspace: asWorkspaceId("/w"),
        sessionId: asSessionId("s1"),
        text: "hello",
    });
    assert.equal(calls[0].method, RPC.sessionPrompt);
    assert.deepEqual(calls[0].params, { workspace: "/w", sessionId: "s1", text: "hello" });
});

test("sessionPrompt 透传 images,images 为空数组时不带该字段", async () => {
    const { dispatch, calls } = mock();
    await createTypedRpc(dispatch).sessionPrompt({
        workspace: asWorkspaceId("/w"),
        sessionId: asSessionId("s1"),
        text: "hi",
        images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });
    assert.deepEqual(calls[0].params, {
        workspace: "/w",
        sessionId: "s1",
        text: "hi",
        images: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    });

    // Empty array → omit images field (avoids triggering "has image but empty" branch in the protocol layer)
    const { dispatch: d2, calls: c2 } = mock();
    await createTypedRpc(d2).sessionPrompt({
        workspace: asWorkspaceId("/w"),
        sessionId: asSessionId("s1"),
        text: "hi",
        images: [],
        attachments: [],
        uiLocale: undefined,
    });
    assert.deepEqual(c2[0].params, { workspace: "/w", sessionId: "s1", text: "hi" });
});

test("sessionSteer / sessionFollowUp 省略空的可选字段", async () => {
    const { dispatch, calls } = mock();
    const rpc = createTypedRpc(dispatch);
    const params = {
        workspace: asWorkspaceId("/w"),
        sessionId: asSessionId("s1"),
        text: "go",
        images: [],
        attachments: ["a"],
    };
    await rpc.sessionSteer(params);
    await rpc.sessionFollowUp(params);
    assert.deepEqual(
        calls.map((c) => [c.method, c.params]),
        [RPC.sessionSteer, RPC.sessionFollowUp].map((m) => [
            m,
            { workspace: "/w", sessionId: "s1", text: "go", attachments: ["a"] },
        ]),
    );
});
