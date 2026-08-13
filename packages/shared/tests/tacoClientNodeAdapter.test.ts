/**
 * TacoClient (Node) typed-method adapter unit tests.
 *
 * Tests two invariants:
 *   1. workspace param is ignored — child_process is single-instance
 *   2. call and callProcess share a path — process and workspace RPC both use call()
 *
 * Avoids spawning a real sidecar by overriding the single-instance `call()`,
 * isolating forwarding logic for all 17 typed methods. Spawn is e2e.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RPC } from "../rpcMethods.js";
import { TacoClient } from "../tacoClientNode.js";

interface Recorded {
    method: string;
    params: unknown;
}

/** Subclassed only to hook call(); the rest is constructed by super() via Object.assign. */
class ThinClient extends TacoClient {
    readonly recorded: Recorded[] = [];
    override async call<TParams = unknown, TResult = unknown>(
        method: string,
        params?: TParams,
    ): Promise<TResult> {
        this.recorded.push({ method, params });
        return undefined as TResult;
    }
}

test("Node adapter: workspace param is ignored; call receives only (method, params)", async () => {
    const client = new ThinClient({ spawn: { command: "true", args: [] } });
    await client.sessionList("/ws/A");
    await client.sessionList("/ws/B/different/path");
    assert.equal(client.recorded.length, 2);
    assert.equal(client.recorded[0].method, RPC.sessionList);
    assert.deepEqual(client.recorded[0].params, { workspace: "/ws/A" });
    assert.equal(client.recorded[1].method, RPC.sessionList);
    assert.deepEqual(client.recorded[1].params, { workspace: "/ws/B/different/path" });
    // workspace is extracted from args by typedRpc factory → passed as call's 2nd param,
    // adapter discards it. If someone changes the adapter to call(method, workspace, params),
    // params here becomes a 3-tuple and deepEqual fails.
});

test("Node adapter: call and callProcess share a call() — process-level and workspace-level RPC converge in the Node single-instance model", async () => {
    const client = new ThinClient({ spawn: { command: "true", args: [] } });
    await client.settingsGet();
    await client.workspaceEnsure("/ws/X");
    assert.equal(client.recorded.length, 2);
    assert.equal(client.recorded[0].method, RPC.settingsGet);
    assert.equal(client.recorded[0].params, undefined);
    assert.equal(client.recorded[1].method, RPC.workspaceEnsure);
    assert.deepEqual(client.recorded[1].params, { cwd: "/ws/X" });
});

test("Node adapter:sessionCreate object 形状透传 workspace", async () => {
    const client = new ThinClient({ spawn: { command: "true", args: [] } });
    await client.sessionCreate({ workspace: "/w", initialPrompt: "hi", thinkingLevel: "low" });
    assert.deepEqual(client.recorded[0].params, {
        workspace: "/w",
        initialPrompt: "hi",
        thinkingLevel: "low",
    });
});
