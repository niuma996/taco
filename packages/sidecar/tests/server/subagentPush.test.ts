import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";

test("workspace lifecycle forwarding keeps started distinct from spawned and preserves settled runId", () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const ws = Object.assign(new EventEmitter(), { permissionBroker: new EventEmitter() });
    const pushes: { method: string; workspace: string; session: string; params: unknown }[] = [];
    const seam = server as unknown as {
        wireWorkspacePush(ws: EventEmitter, workspace: string): void;
        emitPush(method: string, workspace: string, session: string, params: unknown): void;
    };
    seam.emitPush = (method, workspace, session, params) => {
        pushes.push({ method, workspace, session, params });
    };
    seam.wireWorkspacePush(ws, asWorkspaceId("/w"));
    const payload = {
        parentSessionId: asSessionId("parent"),
        parentToolCallId: "original-spawn",
        subSessionId: asSessionId("child"),
        agentType: "reviewer",
        runId: "run-1",
    };
    ws.emit("subagent.started", payload);
    ws.emit("subagent.settled", { ...payload, outcome: "completed" });
    assert.deepEqual(pushes, [
        { method: "subagent.started", workspace: "/w", session: "parent", params: payload },
        {
            method: "subagent.settled",
            workspace: "/w",
            session: "parent",
            params: { ...payload, outcome: "completed" },
        },
    ]);
});
