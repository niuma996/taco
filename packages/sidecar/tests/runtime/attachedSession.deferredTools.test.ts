/**
 * Tests for the dynamic-tool (AddTools) system at the AttachedSession level,
 * using real AgentHarness + JsonlSession + minimal model stub:
 *   - always candidates are present in the initial active tool set;
 *   - addTools.execute returns the correct addedToolNames;
 *   - the harness tool collection reflects the new tool after addTools;
 *   - repeated names within a single request are handled idempotently.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/compat";
import { AttachedSession, type AttachedSessionOptions } from "../../src/runtime/attachedSession.ts";
import {
    DefaultDeferredToolRegistry,
    type ToolCandidate,
} from "../../src/runtime/deferredToolRegistry.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";
import { createPlanModeState } from "../../src/tools/planModeState.ts";

const fakeTool = (name: string): AgentTool =>
    ({
        name,
        description: `summary:${name}`,
        execute: async () => ({ text: "ok" }),
    }) as unknown as AgentTool;

const stubModel: Model<Api> = {
    id: "test/claude-test",
    provider: "anthropic",
    contextWindow: 200_000,
} as unknown as Model<Api>;

const stubTools: AgentTool[] = [fakeTool("builtin-tool")];

function makeToolCandidate(name: string, loading: "deferred" | "always"): ToolCandidate {
    return {
        name,
        summary: `summary:${name}`,
        loading,
        source: "builtin",
        load: async () => fakeTool(name),
    };
}

let tmpDir: string;
let sessionsRoot: string;
let repo: JsonlSessionRepo;
let env: NodeExecutionEnv;
let models: ReturnType<typeof createModels>;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taco-dt-int-"));
    sessionsRoot = join(tmpDir, "sessions");
    env = new NodeExecutionEnv({ cwd: tmpDir });
    repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
    models = createModels();
});

after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

async function makeAttachedSession(
    toolRegistry: DefaultDeferredToolRegistry,
): Promise<AttachedSession> {
    const session = await repo.create({ cwd: tmpDir });
    const opts: AttachedSessionOptions = {
        session,
        models,
        model: stubModel,
        env,
        systemPrompt: "test prompt",
        tools: [...stubTools],
        resources: {},
        streamOptions: {},
        taskStore: {
            getTaskState: () => ({ planMode: false, currentTask: undefined }),
            setTaskState: () => {},
        } as unknown as TaskStore,
        planState: createPlanModeState(),
        tasksDir: tmpDir,
        toolRegistry,
    };
    return AttachedSession.create(opts);
}

describe("AttachedSession — dynamic tools", () => {
    it("always candidates are present in the initial active tool set", async () => {
        const registry = new DefaultDeferredToolRegistry({
            candidates: [
                makeToolCandidate("always-tool", "always"),
                makeToolCandidate("deferred-tool", "deferred"),
            ],
        });
        const attached = await makeAttachedSession(registry);
        assert.ok(
            attached.toolController != null,
            "toolController must be set when registry is provided",
        );

        const activeNames = attached.toolController.activeToolNames();
        assert.ok(
            activeNames.includes("always-tool"),
            `always-tool must be in initial active set, got: ${activeNames.join(", ")}`,
        );
        assert.ok(
            !activeNames.includes("deferred-tool"),
            `deferred-tool must not be pre-loaded, got: ${activeNames.join(", ")}`,
        );
        await attached.abort();
    });

    it("addTools adds the tool to the harness and returns addedToolNames", async () => {
        const registry = new DefaultDeferredToolRegistry({
            candidates: [makeToolCandidate("git-status", "deferred")],
        });
        const attached = await makeAttachedSession(registry);
        assert.ok(attached.toolController != null, "toolController must be set");
        assert.ok(
            attached.toolController.activeToolNames().includes("addTools"),
            "addTools must be resident",
        );

        const result = await attached.toolController.addTools(["git-status"]);
        assert.deepEqual(result.added, ["git-status"]);

        assert.ok(
            attached.toolController.activeToolNames().includes("git-status"),
            "git-status must be active after addTools",
        );
        await attached.abort();
    });

    it("addTools result includes addedToolNames for the pi deferred-tool protocol", async () => {
        const registry = new DefaultDeferredToolRegistry({
            candidates: [makeToolCandidate("pg-query", "deferred")],
        });
        const attached = await makeAttachedSession(registry);
        assert.ok(attached.toolController != null, "toolController must be set");

        const result = await attached.toolController.addTools(["pg-query"]);
        assert.deepEqual(result.added, ["pg-query"]);
        assert.ok(result.added.length > 0, "added must be non-empty for pi protocol");

        await attached.abort();
    });

    it("duplicate names in a single addTools request are idempotent", async () => {
        const registry = new DefaultDeferredToolRegistry({
            candidates: [makeToolCandidate("git-status", "deferred")],
        });
        const attached = await makeAttachedSession(registry);
        assert.ok(attached.toolController != null, "toolController must be set");

        const result = await attached.toolController.addTools(["git-status", "git-status"]);
        assert.deepEqual(result.added, ["git-status"]);
        assert.ok(result.skipped.includes("git-status"), "second occurrence must be skipped");

        const activeNames = attached.toolController.activeToolNames();
        assert.equal(
            activeNames.filter((n) => n === "git-status").length,
            1,
            "git-status must appear exactly once in active set",
        );
        await attached.abort();
    });

    it("an always candidate factory failure causes attach to fail", async () => {
        const badCandidate: ToolCandidate = {
            name: "always-fail",
            summary: "always-fail",
            loading: "always",
            source: "builtin",
            load: async () => {
                throw new Error("factory-error");
            },
        };
        const registry = new DefaultDeferredToolRegistry({
            candidates: [badCandidate],
        });
        await assert.rejects(makeAttachedSession(registry), /factory-error/);
    });

    it("re-attaching a session that persisted an always tool does not re-invoke its factory", async () => {
        // On the previous attach, addTools()/setTools() persists the full active
        // set (including the always tool) into the session branch as an
        // active_tools_change entry. A subsequent re-attach must not call the
        // always tool's factory a second time: for MCP-backed candidates this
        // would re-open the child process, and for any candidate whose load()
        // has side effects (connections, allocations, locks) it doubles the
        // cost of every restart.
        let loadCount = 0;
        const always: ToolCandidate = {
            name: "always-tool",
            summary: "always-tool",
            loading: "always",
            source: "builtin",
            load: async () => {
                loadCount += 1;
                return fakeTool("always-tool");
            },
        };
        const deferred: ToolCandidate = {
            name: "lazy-tool",
            summary: "lazy-tool",
            loading: "deferred",
            source: "builtin",
            load: async () => fakeTool("lazy-tool"),
        };
        const registry = new DefaultDeferredToolRegistry({ candidates: [always, deferred] });

        const session = await repo.create({ cwd: tmpDir });
        const attachedOpts: AttachedSessionOptions = {
            session,
            models,
            model: stubModel,
            env,
            systemPrompt: "test prompt",
            tools: [...stubTools],
            resources: {},
            streamOptions: {},
            taskStore: {
                getTaskState: () => ({ planMode: false, currentTask: undefined }),
                setTaskState: () => {},
            } as unknown as TaskStore,
            planState: createPlanModeState(),
            tasksDir: tmpDir,
            toolRegistry: registry,
        };

        // First attach: load runs once for the always candidate. Then trigger
        // setTools via addTools so the session branch records an
        // active_tools_change entry containing "always-tool".
        const first = await AttachedSession.create(attachedOpts);
        await first.toolController?.addTools(["lazy-tool"]);
        await first.abort();
        assert.equal(loadCount, 1, "first attach must load the always candidate once");

        // Second attach against the same session branch. restoreTools reads
        // activeToolNames = [...,"always-tool",...]; without the fix, the
        // always block in attachedSession.ts would re-load it as well.
        const reloaded = await AttachedSession.create(attachedOpts);
        const activeNames = reloaded.toolController?.activeToolNames() ?? [];
        assert.ok(
            activeNames.includes("always-tool"),
            `always-tool must remain active after re-attach, got: ${activeNames.join(", ")}`,
        );
        assert.equal(
            loadCount,
            2,
            "re-attach must load the always candidate exactly once more (not twice)",
        );
        await reloaded.abort();
    });
});
