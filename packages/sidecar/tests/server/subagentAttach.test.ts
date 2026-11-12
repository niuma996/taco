import assert from "node:assert/strict";
import { test } from "node:test";
import { asSessionId, type SessionAttachResult } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";

test("attach returns optional active chat runs for recovery and tolerates older workspace implementations", async () => {
    const run = {
        parentSessionId: asSessionId("parent"),
        parentToolCallId: "original-spawn",
        subSessionId: asSessionId("child"),
        agentType: "reviewer",
        runId: "run-1",
    };
    for (const activeSubagentChatRuns of [undefined, () => [run]]) {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        server.hydrateSessionEvents = async () => undefined;
        server.ensureWorkspace = async () =>
            ({
                attach: async () => ({ getExecutionState: async () => "idle" }),
                inFlightAgentToolCallIds: () => [],
                settledBackgroundSubSessionIds: async () => ["child"],
                ...(activeSubagentChatRuns
                    ? {
                          activeSubagentChatRuns: (sid: string) => {
                              assert.equal(sid, "parent");
                              return activeSubagentChatRuns();
                          },
                      }
                    : {}),
            }) as never;
        const response = await server.dispatchRpc({
            id: "attach",
            method: "session.attach",
            params: { workspace: "/w", sessionId: "parent" },
        });
        assert.equal(response.ok, true);
        if (!response.ok) return;
        const result = response.result as SessionAttachResult;
        assert.deepEqual(result.activeSubagentChatRuns, activeSubagentChatRuns?.());
        assert.equal("activeSubagentChatRuns" in result, !!activeSubagentChatRuns);
    }
});
