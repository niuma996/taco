/**
 * SessionToolState: the shared queue every runtime tool-state change goes
 * through (dynamic loading, per-turn refresh, attach realignment).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DefaultDeferredToolRegistry } from "../../src/runtime/harness/deferredToolRegistry.ts";
import { DefaultSessionToolController } from "../../src/runtime/harness/sessionToolController.ts";
import { SessionToolState } from "../../src/runtime/harness/sessionToolState.ts";
import {
    alignActiveTools,
    createToolsetRefresher,
} from "../../src/runtime/harness/toolsetRefresh.ts";
import type { TacoTool } from "../../src/tools/index.ts";
import { FakeToolCollection } from "../_helpers/fakeToolCollection.ts";

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

/** Records every write, and lets a test hold the queue at one write. */
class RecordingCollection extends FakeToolCollection {
    writes: string[] = [];
    /** Every active name must have a definition at each write — what pi checks per generation. */
    violations: string[][] = [];
    gate?: Promise<void>;

    override async setTools(tools: Parameters<FakeToolCollection["setTools"]>[0]) {
        await this.gate;
        this.writes.push(`tools:${tools.map((t) => t.name).join(",")}`);
        await super.setTools(tools);
        this.check();
    }

    override async setActiveToolNames(names: readonly string[]) {
        this.writes.push(`active:${names.join(",")}`);
        await super.setActiveToolNames(names);
        this.check();
    }

    private check() {
        const missing = [...this.active].filter((n) => !this.tools.has(n));
        if (missing.length > 0) this.violations.push(missing);
    }
}

function registryOf(names: string[]) {
    return new DefaultDeferredToolRegistry({
        candidates: names.map((name) => ({
            name,
            summary: name,
            loading: "deferred" as const,
            source: "builtin" as const,
            load: async () => fakeTool(name),
        })),
    });
}

describe("SessionToolState", () => {
    it("a refresh queued behind addTools keeps the tool addTools installed", async () => {
        const target = new RecordingCollection([fakeTool("read")]);
        const state = new SessionToolState(target);
        const controller = new DefaultSessionToolController(registryOf(["pg"]));
        controller.bindHarness(state);

        let release!: () => void;
        target.gate = new Promise((r) => {
            release = r;
        });
        let workspace = [fakeTool("read")];
        const refresh = createToolsetRefresher({
            toolState: state,
            installed: { tools: workspace, systemPrompt: "p" },
            refresh: () => ({ tools: workspace, systemPrompt: "p" }),
            setSystemPrompt: () => {},
        });
        workspace = [fakeTool("read"), fakeTool("shell")];

        const adding = controller.addTools(["pg"]);
        const refreshing = refresh();
        release();
        await Promise.all([adding, refreshing]);

        assert.deepEqual([...target.tools.keys()].sort(), ["pg", "read", "shell"]);
        assert.deepEqual([...target.active].sort(), ["pg", "read", "shell"]);
        assert.deepEqual(target.violations, []);
    });

    it("narrows the allowlist before retiring a definition", async () => {
        const target = new RecordingCollection([fakeTool("read"), fakeTool("shell")]);
        const state = new SessionToolState(target);
        let workspace = [fakeTool("read"), fakeTool("shell")];
        const refresh = createToolsetRefresher({
            toolState: state,
            installed: { tools: workspace, systemPrompt: "p" },
            refresh: () => ({ tools: workspace, systemPrompt: "p" }),
            setSystemPrompt: () => {},
        });
        workspace = [workspace[0]];
        await refresh();

        assert.deepEqual(target.writes, ["active:read", "tools:read"]);
        assert.deepEqual(target.violations, []);
    });

    it("writes nothing in the steady state", async () => {
        const target = new RecordingCollection([fakeTool("read")]);
        const state = new SessionToolState(target);
        const controller = new DefaultSessionToolController(registryOf(["pg"]));
        controller.bindHarness(state);
        const workspace = [fakeTool("read")];
        let prompts = 0;
        const refresh = createToolsetRefresher({
            toolState: state,
            installed: { tools: workspace, systemPrompt: "p" },
            refresh: () => ({ tools: workspace, systemPrompt: "p" }),
            setSystemPrompt: () => {
                prompts += 1;
            },
        });

        await controller.addTools(["pg"]);
        target.writes = [];
        await controller.addTools(["pg"]);
        await refresh();
        assert.equal(await alignActiveTools(state, ["read"]), false);

        assert.deepEqual(target.writes, []);
        assert.equal(prompts, 0, "an unchanged toolset must not rewrite the prompt");
    });

    it("keeps an active name that has no definition", async () => {
        const target = new RecordingCollection([fakeTool("read")]);
        target.active.add("mcp-down");
        const state = new SessionToolState(target);
        const controller = new DefaultSessionToolController(registryOf(["pg"]));
        controller.bindHarness(state);

        await controller.addTools(["pg"]);
        assert.ok(target.active.has("mcp-down"), "a tool whose load failed must not be dropped");
    });

    it("a failed commit neither blocks the queue nor advances the refresh baseline", async () => {
        const target = new RecordingCollection([fakeTool("read")]);
        const state = new SessionToolState(target);
        let workspace = [fakeTool("read")];
        let prompt = "old";
        const refresh = createToolsetRefresher({
            toolState: state,
            installed: { tools: workspace, systemPrompt: "old" },
            refresh: () => ({ tools: workspace, systemPrompt: "new" }),
            setSystemPrompt: (p) => {
                prompt = p;
            },
        });
        workspace = [fakeTool("read"), fakeTool("shell")];

        target.gate = Promise.reject(new Error("write failed"));
        target.gate.catch(() => {});
        await assert.rejects(refresh(), /write failed/);
        assert.equal(prompt, "old", "the prompt must not move ahead of the tools");

        target.gate = undefined;
        await refresh();
        assert.ok(target.active.has("shell"), "the next turn retries and converges");
        assert.equal(prompt, "new");
    });
});

describe("toolset refresher baseline", () => {
    const refresherOver = (
        state: SessionToolState,
        installed: TacoTool[],
        workspace: { tools: TacoTool[]; prompt: string },
        prompt: { value: string },
    ) =>
        createToolsetRefresher({
            toolState: state,
            installed: { tools: installed, systemPrompt: prompt.value },
            refresh: () => ({ tools: workspace.tools, systemPrompt: workspace.prompt }),
            setSystemPrompt: (p) => {
                prompt.value = p;
            },
        });

    it("a change between assembly and the first turn is applied, tools and prompt", async () => {
        // attach installed [read, shell] and the old prompt; the policy then
        // revoked shell before the first turn.
        const installed = [fakeTool("read"), fakeTool("shell")];
        const target = new RecordingCollection(installed);
        const state = new SessionToolState(target);
        const workspace = { tools: [fakeTool("read")], prompt: "without shell" };
        const prompt = { value: "with shell" };
        const refresh = refresherOver(state, installed, workspace, prompt);

        await refresh();
        assert.deepEqual([...target.active], ["read"]);
        assert.deepEqual([...target.tools.keys()], ["read"]);
        assert.equal(prompt.value, "without shell");
    });

    it("a prompt rebuilt with the same tool names still reaches the session", async () => {
        const installed = [fakeTool("read")];
        const target = new RecordingCollection(installed);
        const state = new SessionToolState(target);
        const workspace = { tools: installed, prompt: "rebuilt" };
        const prompt = { value: "stale" };
        await refresherOver(state, installed, workspace, prompt)();
        assert.equal(prompt.value, "rebuilt");
        assert.deepEqual(target.writes, [], "a prompt-only change writes no tool state");
    });

    it("overlapping refreshes retire against the state the previous one committed", async () => {
        const installed = [fakeTool("read")];
        const target = new RecordingCollection(installed);
        const state = new SessionToolState(target);
        const workspace = { tools: installed, prompt: "p" };
        const prompt = { value: "p" };
        const refresh = refresherOver(state, installed, workspace, prompt);

        let release!: () => void;
        target.gate = new Promise((r) => {
            release = r;
        });
        workspace.tools = [fakeTool("read"), fakeTool("shell")];
        const first = refresh();
        // Let the first plan read state and reach the gated write.
        await new Promise((r) => setImmediate(r));
        workspace.tools = [fakeTool("read"), fakeTool("write")];
        const second = refresh();
        release();
        await Promise.all([first, second]);

        assert.deepEqual([...target.tools.keys()].sort(), ["read", "write"]);
        assert.deepEqual([...target.active].sort(), ["read", "write"]);
    });
});
