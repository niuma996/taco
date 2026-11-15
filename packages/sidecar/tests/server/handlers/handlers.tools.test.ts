import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import type { ToolsListResult } from "@taco-ai/protocol";
import { DefaultDeferredToolRegistry } from "../../../src/runtime/harness/deferredToolRegistry.ts";
import { registerToolsHandlers } from "../../../src/server/handlers/tools.ts";
import type { TacoTool } from "../../../src/tools/index.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";

const fakeTool = (name: string): TacoTool =>
    ({
        name,
        label: name,
        description: name,
        parameters: {},
        async execute() {
            return { content: [], details: {} };
        },
    }) as unknown as TacoTool;

describe("tools.list", () => {
    before(() => registerToolsHandlers());

    it("skips a broken candidate without failing the whole listing", async () => {
        const toolRegistry = new DefaultDeferredToolRegistry({
            candidates: [
                {
                    name: "brokenExtensionTool",
                    summary: "broken",
                    loading: "deferred",
                    source: "extension",
                    extensionName: "broken-ext",
                    load: async () => {
                        throw new Error("broken candidate");
                    },
                },
                {
                    name: "workingExtensionTool",
                    summary: "working",
                    loading: "deferred",
                    source: "extension",
                    extensionName: "working-ext",
                    load: async () => fakeTool("workingExtensionTool"),
                },
            ],
        });
        const workspace = {
            tools: [],
            extensions: undefined,
            agents: [],
            sessionRegistry: { getListingTools: () => [] },
            toolRegistry,
        };

        const result = await callMethod<ToolsListResult>("tools.list", {
            server: {},
            params: { workspace: "/workspace" },
            workspace,
        });
        assert.ok(result.tools.some((tool) => tool.name === "workingExtensionTool"));
        assert.ok(!result.tools.some((tool) => tool.name === "brokenExtensionTool"));
    });
});
