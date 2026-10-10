/**
 * filterToolsForAgent — whitelist intersection + depth recursion guard (strict match, no alias normalization).
 * Pure function, no I/O.
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/agents/filterTools.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterToolsForAgent, isToolVisibleForAnySubagent } from "../../src/agents/filterTools.ts";
import type { AgentHarnessTool, ExecutionToolContext } from "../../src/runtime/pi/types.ts";

type AgentTool = AgentHarnessTool<ExecutionToolContext>;

function fakeTool(name: string): AgentTool {
    return {
        name,
        label: name,
        description: "",
        parameters: {} as never,
        executionMode: "parallel",
        execute: async () => ({ content: [], details: undefined }),
    } as unknown as AgentTool;
}

const available = ["read", "write", "edit", "grep", "glob", "shell", "agent"].map(fakeTool);

describe("filterToolsForAgent", () => {
    it("intersects whitelist with available tools", () => {
        const out = filterToolsForAgent(available, ["read", "grep", "glob"], 1).map((t) => t.name);
        assert.deepEqual(out.sort(), ["glob", "grep", "read"]);
    });

    it("matches the unified shell tool", () => {
        const out = filterToolsForAgent(available, ["read", "shell"], 1).map((t) => t.name);
        assert.deepEqual(out.sort(), ["read", "shell"]);
    });

    it("drops names not in available set", () => {
        const out = filterToolsForAgent(available, ["read", "unknown"], 1).map((t) => t.name);
        assert.deepEqual(out, ["read"]);
    });

    it("removes agent tool when depth>=1 even if whitelisted", () => {
        const out = filterToolsForAgent(available, ["read", "agent"], 1).map((t) => t.name);
        assert.ok(!out.includes("agent"));
    });

    it("keeps agent tool when depth=0 (parent session)", () => {
        const out = filterToolsForAgent(available, ["read", "agent"], 0).map((t) => t.name);
        assert.ok(out.includes("agent"));
    });

    it("undefined whitelist = all available minus agent (depth>=1)", () => {
        const out = filterToolsForAgent(available, undefined, 1).map((t) => t.name);
        assert.ok(!out.includes("agent"));
        assert.ok(out.includes("read") && out.includes("shell") && out.includes("grep"));
    });

    // Regression: these tools end the run to wait for the user, but answers are
    // only submitted to the parent session — in a child they were unanswerable.
    const interactive = ["askUser", "planEnter", "planExit"];
    const withInteractive = [...available, ...interactive.map(fakeTool)];

    it("strips user-interaction tools from an inheriting subagent (depth>=1)", () => {
        const out = filterToolsForAgent(withInteractive, undefined, 1).map((t) => t.name);
        for (const name of interactive) assert.ok(!out.includes(name), `${name} must be stripped`);
        assert.ok(out.includes("read") && out.includes("shell"));
    });

    it("strips user-interaction tools even when whitelisted (depth>=1)", () => {
        const out = filterToolsForAgent(withInteractive, ["read", ...interactive], 1).map(
            (t) => t.name,
        );
        assert.deepEqual(out, ["read"]);
    });

    it("keeps user-interaction tools for the parent session (depth=0)", () => {
        const out = filterToolsForAgent(withInteractive, undefined, 0).map((t) => t.name);
        for (const name of [...interactive, "agent"]) assert.ok(out.includes(name));
    });
});

describe("isToolVisibleForAnySubagent", () => {
    it("reports main-session-only tools as invisible, even to inheriting agents", () => {
        for (const name of ["agent", "askUser", "planEnter", "planExit"]) {
            assert.equal(isToolVisibleForAnySubagent(name, [undefined]), false, name);
            assert.equal(isToolVisibleForAnySubagent(name, [[name]]), false, name);
        }
    });

    it("still reports ordinary tools by whitelist", () => {
        assert.equal(isToolVisibleForAnySubagent("read", [undefined]), true);
        assert.equal(isToolVisibleForAnySubagent("read", [["read"]]), true);
        assert.equal(isToolVisibleForAnySubagent("write", [["read"]]), false);
    });
});
