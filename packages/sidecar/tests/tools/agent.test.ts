/**
 * agent tool — thin wrapper that forwards params to SubagentSpawnContext.spawn and wraps the result.
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/tools/agent.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { SubagentSpawnContext } from "../../src/agents/types.ts";
import { createAgentTool } from "../../src/tools/agent.ts";

describe("agent tool", () => {
    const mockEnv = new NodeExecutionEnv({ cwd: "/" });

    it("forwards params to spawn and wraps result into content+details", async () => {
        let captured: unknown;
        const ctx: SubagentSpawnContext = {
            async spawn(args) {
                captured = args;
                return { subSessionId: "sub-1", resultText: "done", isError: false };
            },
            async continue() {
                return { subSessionId: "", resultText: "", isError: true };
            },
        };
        const tool = createAgentTool(ctx, ["explorer", "coder"]);
        const res = await tool.execute(
            "tc-parent",
            {
                subagent_type: "explorer",
                description: "find X",
                prompt: "locate the config loader",
            },
            undefined,
            undefined,
            { env: mockEnv },
        );
        assert.deepEqual(captured, {
            parentToolCallId: "tc-parent",
            agentType: "explorer",
            prompt: "locate the config loader",
            signal: undefined,
        });
        assert.equal(res.content[0]?.type, "text");
        const text1 = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.equal(text1, "done");
        assert.deepEqual(res.details, { subSessionId: "sub-1", agentType: "explorer" });
    });

    it("lists available agent types in the description", () => {
        const tool = createAgentTool(
            {
                spawn: async () => ({ subSessionId: "", resultText: "", isError: false }),
                continue: async () => ({ subSessionId: "", resultText: "", isError: true }),
            },
            ["explorer", "coder"],
        );
        assert.ok(tool.description.includes("explorer"));
        assert.ok(tool.description.includes("coder"));
    });

    it("prefixes subagent error result when isError", async () => {
        const tool = createAgentTool(
            {
                spawn: async () => ({
                    subSessionId: "sub-x",
                    resultText: "unknown agent type: bogus",
                    isError: true,
                }),
                continue: async () => ({ subSessionId: "", resultText: "", isError: true }),
            },
            ["explorer"],
        );
        const res = await tool.execute(
            "tc",
            {
                subagent_type: "bogus",
                description: "x",
                prompt: "y",
            },
            undefined,
            undefined,
            { env: mockEnv },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.ok(text.startsWith("subagent error:"));
    });

    it("declares executionMode 'parallel' so multiple agent calls in one turn run concurrently", () => {
        // Guard against accidental regression to "sequential" — the harness
        // collapses the entire batch to sequential when ANY tool is sequential
        // (pi-agent-core's executeToolCalls), so the agent tool must opt into
        // parallel for fan-out to work.
        const tool = createAgentTool(
            {
                spawn: async () => ({ subSessionId: "", resultText: "", isError: false }),
                continue: async () => ({ subSessionId: "", resultText: "", isError: true }),
            },
            ["explorer"],
        );
        assert.equal(tool.executionMode, "parallel");
    });

    it("runs N concurrent execute() calls in parallel (Promise.all semantics)", async () => {
        // Mock spawn that takes 50ms; if execute were sequential the wall time
        // for 3 calls would be ≥ 150ms; with parallel it should be ≈ 50ms.
        const PER_CALL_MS = 50;
        const N = 3;
        let active = 0;
        let peakActive = 0;
        const tool = createAgentTool(
            {
                spawn: async () => {
                    active++;
                    peakActive = Math.max(peakActive, active);
                    await new Promise((r) => setTimeout(r, PER_CALL_MS));
                    active--;
                    return {
                        subSessionId: `sub-${peakActive}`,
                        resultText: `peak-${peakActive}`,
                        isError: false,
                    };
                },
                continue: async () => ({ subSessionId: "", resultText: "", isError: true }),
            },
            ["explorer"],
        );

        const start = Date.now();
        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                tool.execute(
                    `tc-${i}`,
                    { subagent_type: "explorer", description: "x", prompt: "y" },
                    undefined,
                    undefined,
                    { env: mockEnv },
                ),
            ),
        );
        const elapsed = Date.now() - start;

        assert.equal(results.length, N);
        for (const r of results) {
            const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            assert.match(text, /^peak-\d+$/);
            const details = r.details as { agentType: string };
            assert.equal(details.agentType, "explorer");
        }
        assert.ok(
            peakActive >= 2,
            `expected overlapping spawn calls (peak active=${peakActive}), proves Promise.all concurrency`,
        );
        // Loose upper bound: serial would be ≥ 3 * PER_CALL_MS; parallel ≈ PER_CALL_MS.
        assert.ok(
            elapsed < 3 * PER_CALL_MS,
            `wall time ${elapsed}ms suggests sequential execution, not parallel`,
        );
    });
});
