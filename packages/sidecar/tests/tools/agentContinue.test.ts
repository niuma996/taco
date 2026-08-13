/**
 * agentContinue tool — thin shell, like agent. Forwards params to
 * SubagentSpawnContext.continue and wraps the result into content+details.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { SubagentSpawnContext } from "../../src/agents/types.ts";
import { createAgentContinueTool } from "../../src/tools/agentContinue.ts";

describe("agentContinue tool", () => {
    const mockEnv = new NodeExecutionEnv({ cwd: "/" });

    it("forwards params to continue and wraps result into content+details", async () => {
        let captured: unknown;
        const ctx: SubagentSpawnContext = {
            async spawn() {
                return { subSessionId: "", resultText: "", isError: true };
            },
            async continue(args) {
                captured = args;
                return { subSessionId: "sub-9", resultText: "continued", isError: false };
            },
        };
        const tool = createAgentContinueTool(ctx);
        const res = await tool.execute(
            "tc-parent",
            { subSessionId: "sub-1", prompt: "follow up please" },
            undefined,
            undefined,
            { env: mockEnv },
        );
        assert.deepEqual(captured, {
            parentToolCallId: "tc-parent",
            subSessionId: "sub-1",
            prompt: "follow up please",
            signal: undefined,
        });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.equal(text, "continued");
        assert.deepEqual(res.details, { subSessionId: "sub-9" });
    });

    it("prefixes the result with 'subagent continue error:' when isError", async () => {
        const tool = createAgentContinueTool({
            async spawn() {
                return { subSessionId: "", resultText: "", isError: true };
            },
            async continue() {
                return {
                    subSessionId: "sub-x",
                    resultText: "different parent session",
                    isError: true,
                };
            },
        });
        const res = await tool.execute(
            "tc",
            { subSessionId: "sub-x", prompt: "x" },
            undefined,
            undefined,
            { env: mockEnv },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.ok(text.startsWith("subagent continue error:"));
        assert.ok(text.includes("different parent session"));
    });

    it("exposes a `name`, `taco.promptSummary`, and a `subSessionId` schema field", () => {
        const tool = createAgentContinueTool({
            async spawn() {
                return { subSessionId: "", resultText: "", isError: true };
            },
            async continue() {
                return { subSessionId: "", resultText: "", isError: true };
            },
        });
        assert.equal(tool.name, "agentContinue");
        assert.equal(tool.taco?.mutates, true);
        assert.ok(tool.taco?.promptSummary && tool.taco.promptSummary.length > 0);
        const schema = tool.parameters as { properties?: Record<string, unknown> };
        assert.ok(schema.properties && "subSessionId" in schema.properties);
        assert.ok(schema.properties && "prompt" in schema.properties);
    });

    it("declares executionMode 'parallel' for fan-out across distinct subSessionIds", () => {
        // Concurrent agentContinue calls in the same turn only stay parallel
        // when the tool itself is parallel — the harness collapses the whole
        // batch to sequential if any tool is sequential.
        const tool = createAgentContinueTool({
            async spawn() {
                return { subSessionId: "", resultText: "", isError: true };
            },
            async continue() {
                return { subSessionId: "", resultText: "", isError: true };
            },
        });
        assert.equal(tool.executionMode, "parallel");
    });
});
