/**
 * agentContinue tool — thin shell, like agent. Forwards params to
 * SubagentSpawnContext.continue and wraps the result into content+details.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { SubagentSpawnContext } from "../../src/agents/types.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createAgentContinueTool } from "../../src/tools/agentContinue.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

describe("agentContinue tool", () => {
    const mockEnv = new NodeExecutionEnv({ cwd: "/" });

    it("tells the model which subagents can be continued, without naming a runtime", () => {
        const stub = {} as SubagentSpawnContext;
        const { description } = createAgentContinueTool(stub);
        assert.match(
            description,
            /Only subagents of types running on taco's own engine can be continued/,
        );
        assert.match(description, /fresh `agent` call/);
        // The runtime stays invisible to the model: it delegates by agent name.
        assert.doesNotMatch(description, /claude[- ]?code/i);
    });

    it("forwards params to continue and wraps result into content+details", async () => {
        let captured: unknown;
        const spyOnUpdate = (): void => {};
        const ctx: SubagentSpawnContext = {
            async spawn() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            async continue(args) {
                captured = args;
                return {
                    subSessionId: asSessionId("sub-9"),
                    resultText: "continued",
                    isError: false,
                };
            },
            abortSubagent: () => ({ stopped: false }),
        };
        const tool = createAgentContinueTool(ctx);
        const res = await invokeTool(
            tool,
            { subSessionId: "sub-1", prompt: "follow up please" },
            { env: mockEnv },
            { toolCallId: "tc-parent", onUpdate: spyOnUpdate },
        );
        assert.deepEqual(captured, {
            parentToolCallId: "tc-parent",
            subSessionId: "sub-1",
            prompt: "follow up please",
            signal: undefined,
            onUpdate: spyOnUpdate,
        });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.equal(text, "continued");
        assert.deepEqual(res.details, { subSessionId: "sub-9" });
    });

    it("prefixes the result with 'subagent continue error:' when isError", async () => {
        const tool = createAgentContinueTool({
            async spawn() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            async continue() {
                return {
                    subSessionId: asSessionId("sub-x"),
                    resultText: "different parent session",
                    isError: true,
                };
            },
            abortSubagent: () => ({ stopped: false }),
        });
        const res = await invokeTool(
            tool,
            { subSessionId: "sub-x", prompt: "x" },
            { env: mockEnv },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.ok(text.startsWith("subagent continue error:"));
        assert.ok(text.includes("different parent session"));
    });

    it("reports a stopped resume as aborted, without the error prefix", async () => {
        const tool = createAgentContinueTool({
            async spawn() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            async continue() {
                return {
                    subSessionId: asSessionId("sub-s"),
                    resultText: "stopped on purpose",
                    isError: true,
                    aborted: true,
                };
            },
            abortSubagent: () => ({ stopped: false }),
        });
        const res = await invokeTool(
            tool,
            { subSessionId: "sub-s", prompt: "x" },
            { env: mockEnv },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.equal(text, "stopped on purpose");
        assert.deepEqual(res.details, { subSessionId: "sub-s", status: "aborted" });
    });

    it("exposes a `name`, `taco.promptSummary`, and a `subSessionId` schema field", () => {
        const tool = createAgentContinueTool({
            async spawn() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            async continue() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            abortSubagent: () => ({ stopped: false }),
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
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            async continue() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            abortSubagent: () => ({ stopped: false }),
        });
        assert.equal(tool.executionMode, "parallel");
    });
});
