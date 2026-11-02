import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { agentToolPolicy } from "../../src/agents/filterTools.ts";
import {
    DefaultDeferredToolRegistry,
    type ToolCandidate,
} from "../../src/runtime/harness/deferredToolRegistry.ts";
import { DefaultSessionToolController } from "../../src/runtime/harness/sessionToolController.ts";
import { SessionToolState } from "../../src/runtime/harness/sessionToolState.ts";
import type { TacoTool } from "../../src/tools/index.ts";

/**
 * A deferred candidate that loads a stub tool. The candidates stand in for the
 * real deferred pool: `configPatch` mutates the user's global config and
 * takes no path argument, so the mutation gate never sees it — it is the
 * capability a profile's tool list has to be able to withhold.
 */
function candidate(name: string): ToolCandidate {
    return {
        name,
        summary: `stub ${name}`,
        loading: "deferred",
        source: "builtin",
        load: async (): Promise<TacoTool> => ({
            name,
            label: name,
            description: `stub ${name}`,
            parameters: {} as never,
            execute: (async () => ({ content: [] })) as never,
        }),
    };
}

/** A tool collection backed by plain arrays. */
function fakeCollection() {
    const state = { tools: [] as TacoTool[], active: [] as string[] };
    return {
        state,
        collection: {
            getTools: async () => state.tools,
            setTools: async (tools: readonly TacoTool[]) => {
                state.tools = [...tools];
            },
            getActiveToolNames: async () => state.active,
            setActiveToolNames: async (names: readonly string[]) => {
                state.active = [...names];
            },
        },
    };
}

function makeController(loadPolicy?: ReturnType<typeof agentToolPolicy>) {
    const registry = new DefaultDeferredToolRegistry({
        candidates: [candidate("configPatch"), candidate("pdfMerge")],
    });
    const { state, collection } = fakeCollection();
    const controller = new DefaultSessionToolController(registry, loadPolicy ? { loadPolicy } : {});
    const toolState = new SessionToolState(collection);
    controller.bindHarness(toolState);
    return { controller, state, toolState };
}

describe("agentToolPolicy", () => {
    it("restricts a subagent to the tools its profile declared", () => {
        const policy = agentToolPolicy(["read", "grep"], 1);
        assert.ok(policy.allowed);
        assert.equal(policy.allowed.has("read"), true);
        assert.equal(policy.allowed.has("configPatch"), false);
    });

    it("lets a profile that declares no list inherit everything", () => {
        assert.equal(agentToolPolicy(undefined, 1).allowed, undefined);
    });

    it("refuses the main-session-only tools to a subagent", () => {
        const policy = agentToolPolicy(["read", "agent", "askUser"], 1);
        assert.equal(policy.denied.has("agent"), true);
        assert.equal(policy.denied.has("askUser"), true);
    });

    it("does not deny them to a main session", () => {
        assert.equal(agentToolPolicy(["agent"], 0).denied.size, 0);
    });
});

describe("DefaultSessionToolController — load policy", () => {
    it("refuses a tool the profile never declared", async () => {
        const { controller } = makeController(agentToolPolicy(["read", "grep"], 1));
        const result = await controller.addTools(["configPatch"]);
        assert.deepEqual(result.added, []);
        assert.equal(result.blocked.length, 1);
        assert.equal(result.blocked[0].name, "configPatch");
        assert.match(result.blocked[0].reason, /not in the tool list/);
    });

    it("loads a tool the profile declared", async () => {
        const { controller, state } = makeController(
            agentToolPolicy(["read", "grep", "pdfMerge"], 1),
        );
        const result = await controller.addTools(["pdfMerge"]);
        assert.deepEqual(result.added, ["pdfMerge"]);
        assert.equal(state.tools.length, 1);
        assert.deepEqual(state.active, ["pdfMerge"]);
    });

    it("loads anything in a main session", async () => {
        const { controller } = makeController();
        const result = await controller.addTools(["configPatch"]);
        assert.deepEqual(result.added, ["configPatch"]);
        assert.deepEqual(result.blocked, []);
    });

    it("refuses a main-session-only tool even when the profile declared it", async () => {
        const { controller } = makeController(agentToolPolicy(["read", "agent"], 1));
        const result = await controller.addTools(["agent"]);
        assert.deepEqual(result.added, []);
        assert.equal(result.blocked.length, 1);
        assert.match(result.blocked[0].reason, /main-session-only/);
    });

    it("does not restore a persisted tool the profile no longer declares", async () => {
        const { controller } = makeController(agentToolPolicy(["read"], 1));
        const restored = await controller.restoreTools(["configPatch", "pdfMerge"]);
        assert.deepEqual(
            restored.map((t) => t.name),
            [],
        );
    });

    it("restores a persisted tool the profile still declares", async () => {
        const { controller } = makeController(agentToolPolicy(["pdfMerge"], 1));
        const restored = await controller.restoreTools(["pdfMerge"]);
        assert.deepEqual(
            restored.map((t) => t.name),
            ["pdfMerge"],
        );
    });

    it("restores everything in a main session", async () => {
        const { controller } = makeController();
        const restored = await controller.restoreTools(["configPatch"]);
        assert.deepEqual(
            restored.map((t) => t.name),
            ["configPatch"],
        );
    });
});
