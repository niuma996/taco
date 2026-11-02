import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { agentToolPolicy } from "../../src/agents/filterTools.ts";
import {
    DefaultDeferredToolRegistry,
    type ToolCandidate,
} from "../../src/runtime/harness/deferredToolRegistry.ts";
import {
    DefaultSessionToolController,
    loadableCandidates,
} from "../../src/runtime/harness/sessionToolController.ts";
import { SessionToolState } from "../../src/runtime/harness/sessionToolState.ts";
import { pruneLoadRefusedTools } from "../../src/runtime/harness/toolsetRefresh.ts";
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

/** A bare tool object, for names the state must already define. */
function tool(name: string): TacoTool {
    return {
        name,
        label: name,
        description: name,
        parameters: {} as never,
        execute: (async () => ({ content: [] })) as never,
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

describe("setLoadPolicy", () => {
    it("revokes a tool an earlier, looser policy allowed", async () => {
        const { controller, state } = makeController();
        await controller.addTools(["configPatch"]);
        assert.deepEqual(state.active, ["configPatch"]);

        const changed = await controller.setLoadPolicy(agentToolPolicy(["read"], 1));
        assert.equal(changed, true);
        assert.deepEqual(state.active, [], "a tightened policy must hide what it refuses");
    });

    it("is a no-op when the new policy refuses nothing active", async () => {
        const { controller, state } = makeController(agentToolPolicy(["pdfMerge"], 1));
        await controller.addTools(["pdfMerge"]);
        const changed = await controller.setLoadPolicy(agentToolPolicy(["pdfMerge"], 1));
        assert.equal(changed, false);
        assert.deepEqual(state.active, ["pdfMerge"]);
    });

    it("keeps the loader active when the new policy still leaves something loadable", async () => {
        // The shape a resume re-attaches to: the loader was installed at
        // create time because the profile declared a deferred tool. The
        // profile never lists its own loader, so judging it by the whitelist
        // removed it and the session lost its only way to load anything.
        const { controller, state } = makeController(
            agentToolPolicy(["read", "grep", "pdfMerge"], 1),
        );
        state.tools = [tool("addTools")];
        state.active = ["read", "grep", "addTools"];

        const changed = await controller.setLoadPolicy(
            agentToolPolicy(["read", "grep", "pdfMerge"], 1),
        );

        assert.equal(changed, false);
        assert.deepEqual(state.active, ["read", "grep", "addTools"]);
    });

    it("removes the loader when the new policy leaves nothing loadable", async () => {
        const { controller, state } = makeController(agentToolPolicy(["read", "pdfMerge"], 1));
        state.tools = [tool("addTools")];
        state.active = ["read", "addTools"];

        const changed = await controller.setLoadPolicy(agentToolPolicy(["read"], 1));

        assert.equal(changed, true);
        assert.deepEqual(state.active, ["read"]);
    });

    it("re-activates the loader a nothing-loadable policy had idled", async () => {
        const { controller, state } = makeController(agentToolPolicy(["read"], 1));
        state.tools = [tool("addTools")];
        state.active = ["read", "addTools"];
        await controller.setLoadPolicy(agentToolPolicy(["read"], 1));
        assert.deepEqual(state.active, ["read"]);

        const changed = await controller.setLoadPolicy(agentToolPolicy(["read", "pdfMerge"], 1));

        assert.equal(changed, true);
        assert.deepEqual(state.active, ["read", "addTools"]);
    });

    it("re-activates a dynamic tool an earlier tightening had hidden", async () => {
        const { controller, state } = makeController();
        await controller.addTools(["configPatch"]);
        await controller.setLoadPolicy(agentToolPolicy(["read"], 1));
        assert.deepEqual(state.active, []);

        const changed = await controller.setLoadPolicy(agentToolPolicy(["read", "configPatch"], 1));

        assert.equal(changed, true);
        assert.deepEqual(state.active, ["configPatch"]);
    });
});

describe("loadableCandidates", () => {
    it("drops refused candidates and keeps declared ones", () => {
        const { controller } = makeController(agentToolPolicy(["pdfMerge"], 1));
        const out = loadableCandidates([{ name: "configPatch" }, { name: "pdfMerge" }], controller);
        assert.deepEqual(
            out.map((c) => c.name),
            ["pdfMerge"],
        );
    });

    it("keeps every candidate when the session has no policy", () => {
        const { controller } = makeController();
        const candidates = [{ name: "configPatch" }, { name: "pdfMerge" }];
        assert.deepEqual(loadableCandidates(candidates, controller), candidates);
    });
});

describe("pruneLoadRefusedTools", () => {
    it("removes refused names with no definition and keeps defined ones", async () => {
        const { collection, state } = fakeCollection();
        state.tools = [tool("read"), tool("pdfMerge")];
        state.active = ["configPatch", "pdfMerge", "read"];
        const toolState = new SessionToolState(collection);

        const refused = new Set(["configPatch", "pdfMerge"]);
        const changed = await pruneLoadRefusedTools(toolState, (name) => refused.has(name));

        assert.equal(changed, true);
        assert.deepEqual(state.active, ["pdfMerge", "read"]);
    });

    it("writes nothing when nothing is refused", async () => {
        const { collection, state } = fakeCollection();
        state.active = ["read"];
        const toolState = new SessionToolState(collection);
        assert.equal(await pruneLoadRefusedTools(toolState, () => false), false);
        assert.deepEqual(state.active, ["read"]);
    });
});
