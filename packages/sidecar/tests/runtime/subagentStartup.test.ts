import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { asSessionId } from "@taco-ai/protocol";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createTestWorkspace } from "../_helpers/testWorkspace.ts";

describe("subagent startup failures", () => {
    for (const phase of ["create_session", "prepare_attach", "attach"] as const) {
        it(`reports ${phase} before any model invocation and keeps the child id`, async (t) => {
            const faux = fauxProvider({ tokensPerSecond: 0 });
            const models = createModels();
            models.setProvider(faux.provider);
            let modelCalls = 0;
            faux.setResponses([
                () => {
                    modelCalls++;
                    return fauxAssistantMessage("unexpected");
                },
            ]);
            const fixture = createTestWorkspace({
                prefix: "startup-failure",
                models,
                defaultModel: faux.getModel(),
                agents: [
                    {
                        agentType: "explorer",
                        description: "test",
                        systemPrompt: "explore",
                        source: "builtin",
                        filePath: "/agents/explorer.md",
                    },
                ],
            });
            t.after(() => fixture.cleanup());
            const { ws, cwd } = fixture;
            const parent = asSessionId("parent");
            const session = await ws.repo.create({ id: parent, cwd }, harnessContext);
            await session.close(harnessContext);
            const failure = new Error("storage unavailable");
            const method =
                phase === "create_session"
                    ? "createSession"
                    : phase === "prepare_attach"
                      ? "toolsForChildSession"
                      : "attachChild";
            t.mock.method(ws.sessionRegistry, method, async () => {
                throw failure;
            });
            const logs: string[] = [];
            const originalWrite = process.stderr.write.bind(process.stderr);
            t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
                logs.push(String(chunk));
                return originalWrite(chunk);
            });
            const result = await ws.agentSpawner.spawnSubagent({
                parentSessionId: parent,
                parentToolCallId: `call-${phase}`,
                agentType: "explorer",
                prompt: "inspect",
            });
            assert.equal(result.isError, true);
            assert.ok(result.subSessionId);
            assert.equal(result.failurePhase, phase);
            assert.match(result.resultText, /before .*prompt|prompt .*not submitted/i);
            assert.match(result.resultText, /storage unavailable/);
            assert.equal(modelCalls, 0);
            assert.equal(ws.agentSpawner.conversation.state(result.subSessionId), undefined);
            assert.ok(
                logs.some(
                    (line) =>
                        line.includes("subagent startup failed") &&
                        line.includes(phase) &&
                        line.includes(result.subSessionId ?? "") &&
                        line.includes("storage unavailable"),
                ),
            );
            if (phase !== "create_session") {
                const history = await ws.sessionRegistry.getHistory(result.subSessionId);
                assert.equal(history.entries.filter((entry) => entry.type === "message").length, 0);
            }
        });
    }
});
