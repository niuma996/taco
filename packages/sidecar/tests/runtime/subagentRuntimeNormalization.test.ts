import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    normalizeSubagentRuntime,
    sameSubagentRuntime,
} from "../../src/runtime/subagent/engines/runtime.ts";

describe("subagent runtime identity", () => {
    it("maps omitted and legacy runtime values to the standard engine", () => {
        assert.equal(normalizeSubagentRuntime(undefined), "standard");
        assert.equal(normalizeSubagentRuntime("unknown"), "standard");
        assert.equal(normalizeSubagentRuntime("pi"), "standard");
    });

    it("compares runtime values by their canonical identity", () => {
        assert.equal(sameSubagentRuntime("pi", "standard"), true);
        assert.equal(sameSubagentRuntime(undefined, "unknown"), true);
        assert.equal(sameSubagentRuntime("claude-code", "standard"), false);
        assert.equal(sameSubagentRuntime("codex", "codex"), true);
    });
});
