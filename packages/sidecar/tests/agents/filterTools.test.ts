/**
 * filterToolsForAgent — whitelist intersection + depth recursion guard (strict match, no alias normalization).
 * Pure function, no I/O.
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/agents/filterTools.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { filterToolsForAgent } from "../../src/agents/filterTools.ts";

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
});
