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
import { createModels } from "@earendil-works/pi-ai/compat";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { createPlanModeState } from "../../src/plan/planModeState.ts";
import { AttachedSession, type AttachedSessionOptions } from "../../src/runtime/attachedSession.ts";
import {
    DefaultDeferredToolRegistry,
    type ToolCandidate,
} from "../../src/runtime/deferredToolRegistry.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import type { Api, Model } from "../../src/runtime/pi/types.ts";
import { JsonlSessionRepo } from "../../src/runtime/pi/values.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";
import type { TacoToolContext } from "../../src/tools/context.ts";
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

const stubModel: Model<Api> = {
    id: "test/claude-test",
    provider: "anthropic",
    contextWindow: 200_000,
} as unknown as Model<Api>;

const stubTools: TacoTool[] = [fakeTool("builtin-tool")];

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
    repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
    models = createModels();
});

after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

async function makeAttachedSession(
    toolRegistry: DefaultDeferredToolRegistry,
): Promise<AttachedSession> {
    const session = await repo.create({ cwd: tmpDir }, harnessContext);
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
        sessionCwd: tmpDir as never,
        // Dynamic-tool tests don't exercise the tool context path; tools that
        // need `call`/`actor` are tested in their own files.
        getToolContext: () => ({ env, workspace: tmpDir as never }) as TacoToolContext,
        sessionKind: "main",
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

        const activeNames = await attached.toolController.activeToolNames();
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
            (await attached.toolController.activeToolNames()).includes("addTools"),
            "addTools must be resident",
        );

        const result = await attached.toolController.addTools(["git-status"]);
        assert.deepEqual(result.added, ["git-status"]);

        assert.ok(
            (await attached.toolController.activeToolNames()).includes("git-status"),
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

        const activeNames = await attached.toolController.activeToolNames();
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

        const session = await repo.create({ cwd: tmpDir }, harnessContext);
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
            sessionCwd: tmpDir as never,
            getToolContext: (): TacoToolContext => ({
                env,
                workspace: tmpDir as never,
            }),
            sessionKind: "main",
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
        const activeNames = (await reloaded.toolController?.activeToolNames()) ?? [];
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

    it("re-alignment preserves a persisted name whose candidate failed to load", async () => {
        // restoreTools deliberately swallows a failing load and leaves the name
        // on the persisted allowlist so the next attach retries it (an MCP
        // server that is merely down must not cost the user their tool). The
        // allowlist re-alignment intersects against the assembled toolset,
        // which excludes tools that failed to load — so it must not treat
        // "failed to load this time" as "revoked by policy", or a transient MCP
        // outage would silently drop the tool forever.
        let failLoad = true;
        const flaky: ToolCandidate = {
            name: "flaky-mcp-tool",
            summary: "flaky-mcp-tool",
            loading: "deferred",
            source: "mcp",
            load: async () => {
                if (failLoad) throw new Error("mcp server down");
                return fakeTool("flaky-mcp-tool");
            },
        };
        const registry = new DefaultDeferredToolRegistry({ candidates: [flaky] });
        const session = await repo.create({ cwd: tmpDir }, harnessContext);
        const opts = {
            session,
            models,
            model: stubModel,
            env,
            systemPrompt: "test prompt",
            tools: [fakeTool("builtin-tool")],
            resources: {},
            streamOptions: {},
            taskStore: {
                getTaskState: () => ({ planMode: false, currentTask: undefined }),
                setTaskState: () => {},
            } as unknown as TaskStore,
            planState: createPlanModeState(),
            tasksDir: tmpDir,
            toolRegistry: registry,
            sessionCwd: tmpDir as never,
            getToolContext: (): TacoToolContext => ({ env, workspace: tmpDir as never }),
            sessionKind: "main" as const,
        } as AttachedSessionOptions;

        // Load it successfully once so the name lands on the allowlist.
        failLoad = false;
        const first = await AttachedSession.create(opts);
        await first.toolController?.addTools(["flaky-mcp-tool"]);
        assert.ok(
            ((await first.toolController?.activeToolNames()) ?? []).includes("flaky-mcp-tool"),
            "precondition: the tool is on the persisted allowlist",
        );
        await first.abort();

        // Re-attach while the MCP server is down: the load throws, so the tool
        // is absent from the assembled set.
        failLoad = true;
        const reloaded = await AttachedSession.create(opts);
        assert.ok(
            ((await reloaded.toolController?.activeToolNames()) ?? []).includes("flaky-mcp-tool"),
            "a name kept for retry must survive re-alignment, not be dropped as revoked",
        );
        await reloaded.abort();
    });

    it("re-attach re-aligns the persisted allowlist with the assembled toolset", async () => {
        // pi treats configuration.activeToolNames as the authoritative allowlist
        // of what the model may see, defaulting to "all tools passed in" only for
        // a brand-new session; afterwards the value restored from the transcript
        // wins. Since taco does not pass activeToolNames into
        // AgentHarness.create, an existing session used to keep whatever
        // allowlist was persisted by the last addTools() call forever.
        //
        // That froze IM permission edits out of existing conversations both
        // ways: granting tools.shell:"allow" left the tool defined but never
        // exposed (surviving a daemon restart, since the stale allowlist lives
        // in the session file), and revoking a grant did not take effect either.
        const registry = new DefaultDeferredToolRegistry({ candidates: [] });
        const session = await repo.create({ cwd: tmpDir }, harnessContext);
        const baseOpts = {
            session,
            models,
            model: stubModel,
            env,
            systemPrompt: "test prompt",
            resources: {},
            streamOptions: {},
            taskStore: {
                getTaskState: () => ({ planMode: false, currentTask: undefined }),
                setTaskState: () => {},
            } as unknown as TaskStore,
            planState: createPlanModeState(),
            tasksDir: tmpDir,
            toolRegistry: registry,
            sessionCwd: tmpDir as never,
            getToolContext: (): TacoToolContext => ({ env, workspace: tmpDir as never }),
            sessionKind: "main" as const,
        };

        // First attach with a restricted toolset, then persist an allowlist by
        // calling addTools (the only writer of activeToolNames).
        const first = await AttachedSession.create({
            ...baseOpts,
            tools: [fakeTool("keep-me"), fakeTool("revoke-me")],
        } as AttachedSessionOptions);
        await first.toolController?.addTools([]);
        const before = (await first.toolController?.activeToolNames()) ?? [];
        assert.ok(before.includes("revoke-me"), "precondition: allowlist persisted revoke-me");
        assert.ok(!before.includes("grant-me"), "precondition: grant-me not yet assembled");
        await first.abort();

        // Re-attach with a changed toolset: "revoke-me" is gone (policy revoked
        // it) and "grant-me" is new (policy granted it).
        const reloaded = await AttachedSession.create({
            ...baseOpts,
            tools: [fakeTool("keep-me"), fakeTool("grant-me")],
        } as AttachedSessionOptions);
        const after = (await reloaded.toolController?.activeToolNames()) ?? [];
        assert.ok(after.includes("keep-me"), "a still-assembled tool stays active");
        assert.ok(
            after.includes("grant-me"),
            "a newly assembled tool must become active, or a fresh grant stays invisible",
        );
        assert.ok(
            !after.includes("revoke-me"),
            "a no-longer-assembled tool must drop out, or a revoked permission cannot be withdrawn",
        );
        await reloaded.abort();
    });
});
