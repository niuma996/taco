/**
 * DeferredToolRegistry — unit tests for the candidate directory and lazy-load factory.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    DefaultDeferredToolRegistry,
    type DeferredToolRegistryOptions,
    type ToolCandidate,
} from "../../src/runtime/deferredToolRegistry.ts";
import type { TacoTool } from "../../src/tools/index.ts";

const fakeTool = (name: string): TacoTool =>
    ({
        name,
        label: name,
        description: `summary:${name}`,
        parameters: {},
        async execute() {
            return { content: [{ type: "text", text: "ok" }], details: {} };
        },
    }) as unknown as TacoTool;

function candidate(
    name: string,
    opts: Partial<Omit<ToolCandidate, "name" | "load">> = {},
): ToolCandidate {
    return {
        name,
        summary: `summary:${name}`,
        loading: "deferred",
        source: "builtin",
        load: async () => fakeTool(name),
        ...opts,
    };
}

function makeRegistry(candidates: ToolCandidate[]): DefaultDeferredToolRegistry {
    return new DefaultDeferredToolRegistry({ candidates } satisfies DeferredToolRegistryOptions);
}

describe("DeferredToolRegistry", () => {
    it("listDeferred / listAlways filter by loading mode", () => {
        const registry = makeRegistry([
            candidate("git-status", { loading: "deferred" }),
            candidate("pg-query", { loading: "always" }),
        ]);
        assert.deepEqual(
            registry.listDeferred().map((c) => c.name),
            ["git-status"],
        );
        assert.deepEqual(
            registry.listAlways().map((c) => c.name),
            ["pg-query"],
        );
        assert.deepEqual(
            registry.listCandidates().map((c) => c.name),
            ["git-status", "pg-query"],
        );
    });

    it("listCandidates preserves registration order", () => {
        const registry = makeRegistry([candidate("b"), candidate("a"), candidate("c")]);
        assert.deepEqual(
            registry.listCandidates().map((c) => c.name),
            ["b", "a", "c"],
        );
    });

    it("load returns the tool for a known name", async () => {
        const registry = makeRegistry([candidate("git-status")]);
        const tool = await registry.load("git-status");
        assert.equal(tool?.name, "git-status");
    });

    it("load returns undefined for an unknown name", async () => {
        const registry = makeRegistry([candidate("git-status")]);
        assert.equal(await registry.load("nope"), undefined);
    });

    it("constructing with duplicate names throws", () => {
        assert.throws(
            () => makeRegistry([candidate("dup"), candidate("dup")]),
            /duplicate dynamic tool candidate name: dup/,
        );
    });

    it("load propagates factory errors", async () => {
        const registry = makeRegistry([
            {
                name: "boom",
                summary: "explodes",
                loading: "deferred",
                source: "builtin",
                load: async () => {
                    throw new Error("load failed");
                },
            },
        ]);
        await assert.rejects(() => registry.load("boom"), /load failed/);
    });
});
