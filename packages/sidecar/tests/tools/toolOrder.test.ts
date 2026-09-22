/**
 * Deterministic tool order.
 *
 *   pnpm --filter @taco-ai/sidecar test -- tests/tools/toolOrder.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { orderTools, toolNamesKey } from "../../src/tools/toolOrder.ts";

describe("orderTools", () => {
    it("sorts by name with localeCompare, builtins and plugins in one space", () => {
        const input = [{ name: "zzz" }, { name: "write" }, { name: "mcp-a" }, { name: "read" }];
        assert.deepEqual(
            orderTools(input).map((t) => t.name),
            ["mcp-a", "read", "write", "zzz"],
        );
    });

    it("is stable for an already-sorted list", () => {
        const sorted = orderTools([{ name: "edit" }, { name: "read" }, { name: "grep" }]);
        assert.deepEqual(
            orderTools(sorted).map((t) => t.name),
            sorted.map((t) => t.name),
        );
    });
});

describe("toolNamesKey", () => {
    it("treats same-set different order as equal", () => {
        const a = toolNamesKey([{ name: "write" }, { name: "read" }]);
        const b = toolNamesKey([{ name: "read" }, { name: "write" }]);
        assert.equal(a, b);
    });

    it("changes when a name is added", () => {
        const a = toolNamesKey([{ name: "read" }]);
        const b = toolNamesKey([{ name: "read" }, { name: "write" }]);
        assert.notEqual(a, b);
    });
});
