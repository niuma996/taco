/**
 * agent tool — thin wrapper that forwards params to SubagentSpawnContext.spawn and wraps the result.
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/tools/agent.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { SubagentSpawnContext } from "../../src/agents/types.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createAgentTool } from "../../src/tools/agent.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

describe("agent tool", () => {
    const mockEnv = new NodeExecutionEnv({ cwd: "/" });

    /** Non-executing spawn context, for tests that only inspect the description. */
    const stubCtx = (): SubagentSpawnContext => ({
        spawn: async () => ({ subSessionId: asSessionId("stub"), resultText: "", isError: false }),
        continue: async () => ({
            subSessionId: asSessionId("stub"),
            resultText: "",
            isError: true,
        }),
        abortSubagent: () => ({ stopped: false }),
    });

    it("forwards params to spawn and wraps result into content+details", async () => {
        let captured: unknown;
        const spyOnUpdate = (): void => {};
        const ctx: SubagentSpawnContext = {
            async spawn(args) {
                captured = args;
                return { subSessionId: asSessionId("sub-1"), resultText: "done", isError: false };
            },
            async continue() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            abortSubagent: () => ({ stopped: false }),
        };
        const tool = createAgentTool(ctx, [{ agentType: "explorer" }, { agentType: "coder" }]);
        const res = await invokeTool(
            tool,
            {
                subagent_type: "explorer",
                description: "find X",
                prompt: "locate the config loader",
            },
            { env: mockEnv },
            { toolCallId: "tc-parent", onUpdate: spyOnUpdate },
        );
        assert.deepEqual(captured, {
            parentToolCallId: "tc-parent",
            agentType: "explorer",
            prompt: "locate the config loader",
            description: "find X",
            context: undefined,
            background: undefined,
            signal: undefined,
            onUpdate: spyOnUpdate,
        });
        assert.equal(res.content[0]?.type, "text");
        const text1 = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        // The model only sees `content`, so the id agentContinue needs must
        // appear in the text — `details` is UI-only.
        assert.equal(text1, "done\n\n[subagent session: sub-1]");
        assert.deepEqual(res.details, {
            status: "completed",
            subSessionId: "sub-1",
            agentType: "explorer",
        });

        // An explicit `context` override reaches spawn verbatim instead of
        // being defaulted away.
        await invokeTool(
            tool,
            {
                subagent_type: "reviewer",
                description: "review",
                prompt: "review the change",
                context: "fork",
            },
            { env: mockEnv },
            { toolCallId: "tc-parent", onUpdate: spyOnUpdate },
        );
        assert.deepEqual(captured, {
            parentToolCallId: "tc-parent",
            agentType: "reviewer",
            prompt: "review the change",
            description: "review",
            context: "fork",
            background: undefined,
            signal: undefined,
            onUpdate: spyOnUpdate,
        });
    });

    it("launches a background subagent and returns a receipt instead of its output", async () => {
        let captured: unknown;
        const ctx: SubagentSpawnContext = {
            async spawn(args) {
                captured = args;
                return {
                    subSessionId: asSessionId("sub-bg"),
                    resultText: "",
                    isError: false,
                    background: true,
                };
            },
            async continue() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            abortSubagent: () => ({ stopped: false }),
        };
        const tool = createAgentTool(ctx, [{ agentType: "explorer" }]);
        const res = await invokeTool(
            tool,
            {
                subagent_type: "explorer",
                description: "long task",
                prompt: "do something slow",
                background: true,
            },
            { env: mockEnv },
            { toolCallId: "tc-parent" },
        );
        assert.equal((captured as { background?: boolean }).background, true);
        assert.deepEqual(res.details, {
            status: "launched",
            subSessionId: "sub-bg",
            agentType: "explorer",
        });
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.ok(text.includes("launched in background"));
        assert.ok(!text.includes("done"), "receipt must not contain the child's eventual output");
    });

    it("reports a background launch failure without a session id", async () => {
        const ctx: SubagentSpawnContext = {
            async spawn() {
                return {
                    resultText: "concurrency limit reached",
                    isError: true,
                    background: true,
                };
            },
            async continue() {
                return { subSessionId: asSessionId("stub"), resultText: "", isError: true };
            },
            abortSubagent: () => ({ stopped: false }),
        };
        const tool = createAgentTool(ctx, [{ agentType: "explorer" }]);
        const res = await invokeTool(
            tool,
            {
                subagent_type: "explorer",
                description: "long task",
                prompt: "do something slow",
                background: true,
            },
            { env: mockEnv },
            { toolCallId: "tc-parent" },
        );
        // A failed launch must not read as "completed" — that is what put a
        // green check on a card whose own text said it failed.
        assert.deepEqual(res.details, { status: "error", agentType: "explorer" });
        assert.equal(res.isError, true);
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.ok(text.startsWith("failed to launch background subagent:"));
    });

    it("keeps a frozen description that does not embed the type catalog", () => {
        const withTypes = createAgentTool(stubCtx(), [
            { agentType: "explorer" },
            { agentType: "coder" },
        ]);
        const empty = createAgentTool(stubCtx(), []);
        assert.equal(withTypes.description, empty.description);
        assert.ok(withTypes.description.includes("<available_agents>"));
        assert.ok(!withTypes.description.includes("explorer"));
        assert.ok(!withTypes.description.includes("coder"));
    });

    it("explains independent context, not only what fork adds", () => {
        // The model picks this parameter from its description alone. A fork-only
        // description leaves "independent" undefined and the trade-off (restate
        // everything vs. inherit framing) invisible, so both modes must be stated.
        const tool = createAgentTool(stubCtx(), []);
        const ctx = JSON.stringify(tool.parameters) as string;
        assert.ok(ctx.includes("independent"), "independent is not described at all");
        assert.ok(ctx.includes("starts blank"), "does not say what independent gives");
        assert.ok(ctx.includes("restate every path"), "does not say what independent costs");
        assert.ok(ctx.includes("inherits this conversation"), "does not state fork's cost");
    });

    it("does not embed frontmatter hints in the tool JSON", () => {
        const tool = createAgentTool(stubCtx(), [
            { agentType: "explorer", description: "read-only search specialist" },
            { agentType: "my-migrator", description: "runs schema migrations" },
        ]);
        assert.ok(!tool.description.includes("read-only search specialist"));
        assert.ok(!tool.description.includes("runs schema migrations"));
    });

    it("prefixes subagent error result when isError", async () => {
        const tool = createAgentTool(
            {
                spawn: async () => ({
                    subSessionId: asSessionId("sub-x"),
                    resultText: "unknown agent type: bogus",
                    isError: true,
                }),
                continue: async () => ({
                    subSessionId: asSessionId("stub"),
                    resultText: "",
                    isError: true,
                }),
                abortSubagent: () => ({ stopped: false }),
            },
            [{ agentType: "explorer" }],
        );
        const res = await invokeTool(
            tool,
            {
                subagent_type: "bogus",
                description: "x",
                prompt: "y",
            },
            { env: mockEnv },
            { toolCallId: "tc" },
        );
        const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.ok(text.startsWith("subagent error:"));
        // Same contract as the background branch: a failure is an error, not a
        // completed card. `isError` is what pi persists and the desktop colours.
        assert.equal(res.isError, true);
        assert.deepEqual(res.details, { status: "error", agentType: "bogus" });
    });

    it("declares executionMode 'parallel' so multiple agent calls in one turn run concurrently", () => {
        // Guard against accidental regression to "sequential" — the harness
        // collapses the entire batch to sequential when ANY tool is sequential
        // (pi-agent-core's executeToolCalls), so the agent tool must opt into
        // parallel for fan-out to work.
        const tool = createAgentTool(
            {
                spawn: async () => ({
                    subSessionId: asSessionId("stub"),
                    resultText: "",
                    isError: false,
                }),
                continue: async () => ({
                    subSessionId: asSessionId("stub"),
                    resultText: "",
                    isError: true,
                }),
                abortSubagent: () => ({ stopped: false }),
            },
            [{ agentType: "explorer" }],
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
                        subSessionId: asSessionId(`sub-${peakActive}`),
                        resultText: `peak-${peakActive}`,
                        isError: false,
                    };
                },
                continue: async () => ({
                    subSessionId: asSessionId("stub"),
                    resultText: "",
                    isError: true,
                }),
                abortSubagent: () => ({ stopped: false }),
            },
            [{ agentType: "explorer" }],
        );

        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                invokeTool(
                    tool,
                    { subagent_type: "explorer", description: "x", prompt: "y" },
                    { env: mockEnv },
                    { toolCallId: `tc-${i}` },
                ),
            ),
        );

        assert.equal(results.length, N);
        for (const r of results) {
            const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            assert.match(text, /^peak-\d+\n\n\[subagent session: sub-\d+\]$/);
            const details = r.details as { agentType: string };
            assert.equal(details.agentType, "explorer");
        }
        // Overlap is the proof of concurrency: a serial execute() would never
        // have two spawns in flight at once. A wall-clock bound used to sit
        // here too, but it failed under suite load (164ms vs a 150ms limit)
        // while proving nothing peakActive does not.
        assert.equal(
            peakActive,
            N,
            `expected all ${N} spawn calls in flight together (peak active=${peakActive}), proves Promise.all concurrency`,
        );
    });
});
