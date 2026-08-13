/**
 * addTools tool — schema / description / execute unit tests.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import {
    DefaultDeferredToolRegistry,
    type ToolCandidate,
} from "../../src/runtime/deferredToolRegistry.ts";
import {
    type AddToolsResult,
    DefaultSessionToolController,
} from "../../src/runtime/sessionToolController.ts";
import { type AddToolsToolInput, createAddToolsTool } from "../../src/tools/addTools.ts";
import type { TacoTool } from "../../src/tools/index.ts";
import { FakeToolCollection } from "../_helpers/fakeToolCollection.ts";

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

function makeRegistry(names: string[]): DefaultDeferredToolRegistry {
    return new DefaultDeferredToolRegistry({
        candidates: names.map(
            (name): ToolCandidate => ({
                name,
                summary: `summary:${name}`,
                loading: "deferred",
                source: "builtin",
                load: async () => fakeTool(name),
            }),
        ),
    });
}

function makeTool(names: string[]): { tool: TacoTool; controller: DefaultSessionToolController } {
    const registry = makeRegistry(names);
    const controller = new DefaultSessionToolController(registry);
    controller.bindHarness(new FakeToolCollection([fakeTool("read")]));
    return { tool: createAddToolsTool(controller), controller };
}

const ctx = {} as ExecutionToolContext;

describe("addTools tool schema", () => {
    it("accepts comma-separated toolNames", () => {
        const { tool } = makeTool(["git-status"]);
        const input: AddToolsToolInput = { toolNames: "git-status, pg-query" };
        assert.equal(Value.Check(tool.parameters, input), true);
    });

    it("rejects non-string toolNames", () => {
        const { tool } = makeTool(["git-status"]);
        assert.equal(Value.Check(tool.parameters, { toolNames: 42 }), false);
    });
});

describe("addTools description", () => {
    it("lists deferred candidates with name and summary", () => {
        const { tool } = makeTool(["git-status", "pg-query"]);
        assert.ok(tool.description.includes("git-status"));
        assert.ok(tool.description.includes("summary:git-status"));
        assert.ok(tool.description.includes("pg-query"));
        assert.ok(tool.description.includes("summary:pg-query"));
    });

    it("reflects registry changes after loading (description is a getter)", async () => {
        const registry = makeRegistry(["git-status", "pg-query"]);
        const controller = new DefaultSessionToolController(registry);
        controller.bindHarness(new FakeToolCollection([]));
        const tool = createAddToolsTool(controller);
        assert.ok(tool.description.includes("pg-query"));

        // After loading, the tool leaves the deferred list.
        await controller.addTools(["git-status"]);
        assert.ok(
            !tool.description.includes("git-status"),
            "loaded tool must leave the deferred list",
        );
        assert.ok(tool.description.includes("pg-query"));
    });

    it("says none available when no deferred candidates", () => {
        const { tool } = makeTool([]);
        assert.ok(tool.description.includes("No deferred tools available"));
    });
});

describe("addTools execute", () => {
    const details = (result: Awaited<ReturnType<TacoTool["execute"]>>): AddToolsResult =>
        result.details as AddToolsResult;
    const addedNames = (result: Awaited<ReturnType<TacoTool["execute"]>>) => result.addedToolNames;

    it("adds tools and reports the result", async () => {
        const { tool, controller } = makeTool(["git-status"]);
        const result = await tool.execute(
            "tc1",
            { toolNames: "git-status" },
            undefined,
            undefined,
            ctx,
        );
        assert.deepEqual(details(result).added, ["git-status"]);
        assert.deepEqual(controller.loadedToolNames(), ["git-status"]);
    });

    it("returns addedToolNames on success (pi deferred-tool protocol)", async () => {
        const { tool } = makeTool(["git-status", "pg-query"]);
        const result = await tool.execute(
            "tc1",
            { toolNames: "git-status" },
            undefined,
            undefined,
            ctx,
        );
        assert.deepEqual(addedNames(result), ["git-status"]);
    });

    it("omits addedToolNames when nothing was added", async () => {
        const { tool } = makeTool(["git-status"]);
        const result = await tool.execute("tc1", { toolNames: "nope" }, undefined, undefined, ctx);
        assert.deepEqual(addedNames(result), undefined);
    });

    it("reports unknown tools in the result", async () => {
        const { tool } = makeTool(["git-status"]);
        const result = await tool.execute("tc1", { toolNames: "nope" }, undefined, undefined, ctx);
        assert.deepEqual(details(result).unknown, ["nope"]);
        assert.deepEqual(details(result).added, []);
    });

    it("reports already-loaded tools as skipped (idempotent)", async () => {
        const { tool } = makeTool(["git-status"]);
        await tool.execute("tc1", { toolNames: "git-status" }, undefined, undefined, ctx);
        const second = await tool.execute(
            "tc2",
            { toolNames: "git-status" },
            undefined,
            undefined,
            ctx,
        );
        assert.deepEqual(details(second).skipped, ["git-status"]);
        assert.deepEqual(details(second).added, []);
    });

    it("deduplicates repeated names within a single request", async () => {
        const { tool, controller } = makeTool(["git-status"]);
        const result = await tool.execute(
            "tc1",
            { toolNames: "git-status, git-status" },
            undefined,
            undefined,
            ctx,
        );
        assert.deepEqual(details(result).added, ["git-status"]);
        assert.deepEqual(details(result).skipped, ["git-status"]);
        assert.equal(controller.loadedToolNames().filter((n) => n === "git-status").length, 1);
    });
});
