/**
 * mcpToolName — provider-safe tool-name mapping and collision resolution.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { dedupeName, MAX_TOOL_NAME_LENGTH, mcpToolName } from "../../src/mcp/mcpToolName.ts";

describe("mcpToolName", () => {
    it("prefixes with mcp__<serverId>__", () => {
        assert.equal(mcpToolName("github", "list_issues"), "mcp__github__list_issues");
    });

    it("replaces characters outside [a-zA-Z0-9_-] with underscores", () => {
        assert.equal(mcpToolName("svc", "my tool!"), "mcp__svc__my_tool_");
        assert.equal(mcpToolName("svc", "中文工具"), "mcp__svc______");
    });

    it("truncates the total to 128 chars", () => {
        const name = mcpToolName("svc", "t".repeat(200));
        assert.equal(name.length, MAX_TOOL_NAME_LENGTH);
        assert.ok(/^[a-zA-Z0-9_-]+$/.test(name));
    });

    it("keeps the prefix when truncating", () => {
        const name = mcpToolName("svc", "t".repeat(200));
        assert.ok(name.startsWith("mcp__svc__"));
    });
});

describe("dedupeName", () => {
    it("returns the name unchanged when free", () => {
        assert.equal(dedupeName("a", new Set(["b"])), "a");
    });

    it("appends _2 for the first collision", () => {
        assert.equal(dedupeName("a", new Set(["a"])), "a_2");
    });

    it("increments past taken suffixes", () => {
        assert.equal(dedupeName("a", new Set(["a", "a_2", "a_3"])), "a_4");
    });

    it("keeps the result within the provider 128-char limit", () => {
        const base = "m".repeat(128);
        const name = dedupeName(base, new Set([base]));
        assert.equal(name.length, MAX_TOOL_NAME_LENGTH);
        assert.ok(name.endsWith("_2"));
    });
});
