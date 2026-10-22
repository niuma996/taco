// Builtin tool tests: default catalog, ordering, edit, task, memory, and plan tools.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { MemoryUpsertParams } from "@taco-ai/protocol";
import { asSessionId, asWorkspaceId, MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { createPlanModeState, enterPlanMode } from "../../src/plan/planModeState.ts";
import { NoopPlanPushAdapter } from "../../src/plan/planPushAdapter.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { createEditTool } from "../../src/runtime/pi/values.ts";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import { addTask, createTaskList } from "../../src/tasks/taskMutations.ts";
import type { TaskList } from "../../src/tasks/taskTypes.ts";
import type { TacoToolContext } from "../../src/tools/context.ts";
import { defaultTools, defaultToolsWithTasks } from "../../src/tools/index.ts";
import { createMemoryTool, type MemoryToolInput } from "../../src/tools/memory.ts";
import { createPlanExitTool, type PlanExitToolDetails } from "../../src/tools/planExit.ts";
import { createTaskCreateTool } from "../../src/tools/taskCreate.ts";
import { createTaskUpdateTool } from "../../src/tools/taskUpdate.ts";
import { createTodoWriteTool } from "../../src/tools/todoWrite.ts";
import { orderTools, toolNamesKey } from "../../src/tools/toolOrder.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { TEST_SESSION_ID, testTaskPublisher } from "./_helpers.ts";

describe("defaultTools", () => {
    it("base defaultTools does NOT include task tools", () => {
        const tools = defaultTools();
        const names = tools.map((t) => t.name);
        assert.equal(names.includes("todoWrite"), false);
        assert.equal(names.includes("taskCreate"), false);
    });

    it("base defaultTools does NOT include plan tools", () => {
        const tools = defaultTools();
        const names = tools.map((t) => t.name);
        assert.equal(names.includes("planEnter"), false);
        assert.equal(names.includes("planExit"), false);
    });
});

describe("defaultToolsWithTasks", () => {
    it("includes all 4 task management tools and no taskGet", () => {
        const store = createTaskStore("test-session");
        const planState = createPlanModeState();
        const tools = defaultToolsWithTasks(
            store,
            "/tmp/fake-tasks",
            planState,
            "/tmp/fake-project",
            testTaskPublisher(),
            new NoopPlanPushAdapter(),
            TEST_SESSION_ID,
        );
        const names = tools.map((t) => t.name);

        assert.ok(names.includes("todoWrite"));
        assert.ok(names.includes("taskCreate"));
        assert.ok(names.includes("taskUpdate"));
        assert.ok(names.includes("taskList"));
        assert.equal(names.includes("taskGet"), false);
    });

    it("includes both plan mode tools", () => {
        const store = createTaskStore("test-session");
        const planState = createPlanModeState();
        const tools = defaultToolsWithTasks(
            store,
            "/tmp/fake-tasks",
            planState,
            "/tmp/fake-project",
            testTaskPublisher(),
            new NoopPlanPushAdapter(),
            TEST_SESSION_ID,
        );
        const names = tools.map((t) => t.name);

        assert.ok(names.includes("planEnter"));
        assert.ok(names.includes("planExit"));
    });

    it("still includes base tools", () => {
        const store = createTaskStore("test-session");
        const planState = createPlanModeState();
        const tools = defaultToolsWithTasks(
            store,
            "/tmp/fake-tasks",
            planState,
            "/tmp/fake-project",
            testTaskPublisher(),
            new NoopPlanPushAdapter(),
            TEST_SESSION_ID,
        );
        const names = tools.map((t) => t.name);
        const hasShell = names.includes("shell");
        assert.ok(hasShell);
        assert.ok(names.includes("read"));
        assert.ok(names.includes("grep"));
    });
});

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

describe("edit tool — file content after edits", () => {
    let cwd: string;

    before(() => {
        cwd = mkdtempSync(join(tmpdir(), "edit-"));
    });

    after(() => {
        rmSync(cwd, { recursive: true, force: true });
    });

    async function runEdit(
        cwd: string,
        path: string,
        edits: Array<{ oldText: string; newText: string }>,
    ): Promise<void> {
        const env = new NodeExecutionEnv({ cwd });
        const tool = createEditTool();
        await invokeTool(tool, { path, edits }, { env }, { toolCallId: "tc" });
    }

    function read(path: string): string {
        return readFileSync(join(cwd, path), "utf-8");
    }

    it("文件开头替换", async () => {
        const file = "start.ts";
        writeFileSync(join(cwd, file), "const a = 1;\nconst b = 2;\n", "utf-8");
        await runEdit(cwd, file, [{ oldText: "const a = 1;", newText: "const a = 11;" }]);
        assert.equal(read(file), "const a = 11;\nconst b = 2;\n");
    });

    it("文件中段替换", async () => {
        const file = "middle.ts";
        writeFileSync(join(cwd, file), "line1\nline2\nline3\n", "utf-8");
        await runEdit(cwd, file, [{ oldText: "line2", newText: "LINE_TWO" }]);
        assert.equal(read(file), "line1\nLINE_TWO\nline3\n");
    });

    it("多行 oldText / newText", async () => {
        const file = "multi.ts";
        writeFileSync(join(cwd, file), "a\nb\nc\nd\n", "utf-8");
        await runEdit(cwd, file, [{ oldText: "b\nc", newText: "B\nC\nC2" }]);
        assert.equal(read(file), "a\nB\nC\nC2\nd\n");
    });

    it("多条 edit 顺序应用", async () => {
        const file = "two.ts";
        writeFileSync(join(cwd, file), "alpha\nbeta\ngamma\n", "utf-8");
        await runEdit(cwd, file, [
            { oldText: "alpha", newText: "ALPHA_PADDING" },
            { oldText: "gamma", newText: "g" },
        ]);
        assert.equal(read(file), "ALPHA_PADDING\nbeta\ng\n");
    });

    it("跨行 edit 后文件内容正确", async () => {
        const file = "shift.ts";
        writeFileSync(join(cwd, file), "line1\nline2\nline3\nline4\n", "utf-8");
        await runEdit(cwd, file, [
            { oldText: "line1", newText: "verylongnewstring" },
            { oldText: "line4", newText: "L4" },
        ]);
        assert.equal(read(file), "verylongnewstring\nline2\nline3\nL4\n");
    });

    it("oldText 不匹配时抛出错误", async () => {
        const file = "nomatch.ts";
        writeFileSync(join(cwd, file), "hello\n", "utf-8");
        await assert.rejects(
            async () => runEdit(cwd, file, [{ oldText: "not present", newText: "replacement" }]),
            (e: unknown) => String(e).includes("oldText") || String(e).includes("match"),
        );
    });
});

describe("taskCreate tool", () => {
    let testDir: string;
    let store: ReturnType<typeof createTaskStore>;

    before(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-tasks-test-"));
        store = createTaskStore("test-session");
    });

    after(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    afterEach(() => {
        store.lists.clear();
        store.currentListId = null;
    });

    it("should create a new task list", async () => {
        const tool = createTaskCreateTool(store, testDir, testTaskPublisher(), TEST_SESSION_ID);
        const result = await invokeTool(
            tool,
            {
                listName: "Sprint 1",
                tasks: [
                    {
                        content: "Task 1",
                        status: "pending",
                        activeForm: "Working on task 1",
                    },
                ],
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        assert.equal(store.lists.size, 1);
        const list = store.lists.values().next().value;
        assert.equal(list?.name, "Sprint 1");
        assert.equal(list?.tasks.length, 1);
        assert.equal(store.currentListId, list?.id);
        assert.equal((result.details as { listId: string | null }).listId, list?.id);
    });

    it("refuses to create when another list is still active", async () => {
        const tool = createTaskCreateTool(store, testDir, testTaskPublisher(), TEST_SESSION_ID);

        // Seed an active list
        createTaskList(store, "sprint-1", "Sprint 1");
        addTask(store, "sprint-1", { content: "Task 1", status: "pending", activeForm: "Working" });
        store.currentListId = "sprint-1";

        const result = await invokeTool(
            tool,
            {
                listName: "Sprint 2",
                tasks: [{ content: "Task 2", status: "pending", activeForm: "Working on task 2" }],
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tc-2" },
        );

        assert.equal(store.lists.size, 1);
        const textContent = result.content[0];
        assert.equal(textContent.type, "text");
        if (textContent.type !== "text") throw new Error("expected text content");
        assert.match(textContent.text, /active|unfinished|still active/i);
        assert.equal((result.details as { listId: string | null }).listId, null);
    });

    it("returns taskIds in details and content text so LLM can read them", async () => {
        const tool = createTaskCreateTool(store, testDir, testTaskPublisher(), TEST_SESSION_ID);
        const result = await invokeTool(
            tool,
            {
                listName: "Sprint 3",
                tasks: [
                    { content: "First", status: "pending", activeForm: "Doing first" },
                    { content: "Second", status: "in_progress", activeForm: "Doing second" },
                ],
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        const details = result.details as { taskIds: string[] };
        assert.deepEqual(details.taskIds, ["task-1", "task-2"]);
        const textContent = result.content[0];
        assert.equal(textContent.type, "text");
        if (textContent.type !== "text") throw new Error("expected text content");
        assert.match(textContent.text, /task-1/);
        assert.match(textContent.text, /task-2/);
    });
});

describe("taskUpdate tool", () => {
    let testDir: string;
    let store: ReturnType<typeof createTaskStore>;

    before(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-tasks-test-"));
        store = createTaskStore("test-session");
        createTaskList(store, "test-list", "Test List");
        addTask(store, "test-list", {
            content: "Task 1",
            status: "pending",
            activeForm: "Working on task 1",
        });
    });

    after(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("should update task status", async () => {
        const tool = createTaskUpdateTool(store, testDir, testTaskPublisher(), TEST_SESSION_ID);
        const _result = await invokeTool(
            tool,
            {
                listId: "test-list",
                taskId: "task-1",
                updates: {
                    status: "completed",
                },
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        const list = store.lists.get("test-list");
        assert.equal(list?.tasks[0].status, "completed");
    });
});

describe("taskUpdate — clears currentListId when the active list runs out of unfinished tasks", () => {
    let testDir: string;

    before(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-tasks-test-"));
    });

    after(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("resets currentListId to null after all tasks reach a terminal status", async () => {
        const store = createTaskStore("session-clears");
        createTaskList(store, "l1", "list");
        addTask(store, "l1", { content: "x", status: "pending", activeForm: "x" });
        store.currentListId = "l1";

        const tool = createTaskUpdateTool(store, testDir, testTaskPublisher(), TEST_SESSION_ID);
        await invokeTool(
            tool,
            { taskId: "task-1", updates: { status: "completed" } },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tu" },
        );

        assert.equal(store.currentListId, null);
    });
});

describe("todoWrite tool", () => {
    let testDir: string;
    let store: ReturnType<typeof createTaskStore>;

    before(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-tasks-test-"));
        store = createTaskStore("test-scope");
    });

    after(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("should create a new list when no active list exists", async () => {
        const tool = createTodoWriteTool(store, testDir, testTaskPublisher(), TEST_SESSION_ID);
        const result = await invokeTool(
            tool,
            {
                todos: [
                    {
                        content: "Task 1",
                        status: "pending",
                        activeForm: "Working on task 1",
                    },
                    {
                        content: "Task 2",
                        status: "in_progress",
                        activeForm: "Working on task 2",
                    },
                ],
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        assert.equal(result.content[0].type, "text");
        if (result.content[0].type === "text") {
            assert.match(result.content[0].text, /2 tasks updated/);
        }

        assert.equal(store.lists.size, 1);
        const list = store.lists.values().next().value as TaskList | undefined;
        assert.ok(list);
        assert.equal(list.tasks.length, 2);
        assert.equal(list.tasks[0].content, "Task 1");
        assert.equal(list.tasks[1].status, "in_progress");
        assert.equal(store.currentListId, list.id);
    });

    it("should replace tasks on the current active list", async () => {
        const tool = createTodoWriteTool(store, testDir, testTaskPublisher(), TEST_SESSION_ID);

        // First call creates active list
        await invokeTool(
            tool,
            {
                todos: [{ content: "Task 1", status: "pending", activeForm: "Working on task 1" }],
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        const firstListId = store.currentListId;
        assert.ok(firstListId);

        // Second call replaces the same active list
        await invokeTool(
            tool,
            {
                todos: [{ content: "Task 2", status: "pending", activeForm: "Working on task 2" }],
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tc-2" },
        );

        assert.equal(store.currentListId, firstListId);
        const list = store.lists.get(firstListId);
        assert.equal(list?.tasks.length, 1);
        assert.equal(list?.tasks[0].content, "Task 2");
    });

    it("should target the active list even if currentListId is null", async () => {
        const scopedStore = createTaskStore("active-scope");
        createTaskList(scopedStore, "l1", "existing");
        addTask(scopedStore, "l1", { content: "old", status: "pending", activeForm: "old" });
        scopedStore.currentListId = null;

        const tool = createTodoWriteTool(
            scopedStore,
            testDir,
            testTaskPublisher(),
            TEST_SESSION_ID,
        );
        await invokeTool(
            tool,
            {
                todos: [{ content: "new", status: "in_progress", activeForm: "new" }],
            },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        const list = scopedStore.lists.get("l1");
        assert.equal(list?.tasks.length, 1);
        assert.equal(list?.tasks[0].content, "new");
    });
});

const VALID: MemoryToolInput = {
    action: "add",
    id: "web-search-preference",
    name: "Web search default",
    description: "Default to mmx-cli for web search",
    content: "Use mmx-cli skill by default.",
    type: "user",
};

describe("memory tool schema", () => {
    const tool = createMemoryTool();

    it("accepts flat envelope (action at top level)", () => {
        assert.equal(Value.Check(tool.parameters, VALID), true);
    });

    it("rejects the legacy nested shape ({action: {action: 'add', ...}})", () => {
        const legacyNested = {
            action: {
                action: "add",
                id: "web-search-preference",
                name: "x",
                content: "y",
                type: "user",
            },
        };
        // The legacy shape is invalid because top-level `action` is now the
        // dispatch string, not an envelope object — so other required keys
        // (id, name, content, type) appear missing.
        assert.equal(Value.Check(tool.parameters, legacyNested), false);
    });

    it("rejects kebab-case violations on id (snake_case, uppercase, spaces, empty, overlong)", () => {
        // The handler whitelists `^[a-z0-9-]+$` — any character outside that
        // set makes the sanitized value differ from the input. Our JSON
        // Schema pattern encodes the same whitelist so the LLM never reaches
        // the handler with a bad id.
        for (const badId of [
            "user_web_search_preference", // snake_case — the exact bug from the session
            "UPPER",
            "with space",
            "",
            "x".repeat(65),
            "with.dot",
            "with/slash",
        ]) {
            const input = { ...VALID, id: badId };
            assert.equal(
                Value.Check(tool.parameters, input),
                false,
                `id "${badId}" must be rejected by the JSON Schema pattern`,
            );
        }
    });

    it("accepts a range of valid kebab-case ids (including edge hyphens, matching the handler)", () => {
        // Handler regex is `^[a-z0-9-]+$` (loose kebab). Mirror that — anything
        // composed of lowercase/digits/hyphens, 1-64 chars — so schema and
        // handler agree on what is valid.
        for (const okId of [
            "user-role",
            "feedback-auth",
            "a",
            "abc-123",
            "x".repeat(64),
            "trailing-",
            "-leading",
        ]) {
            assert.equal(
                Value.Check(tool.parameters, { ...VALID, id: okId }),
                true,
                `id "${okId}" must be accepted`,
            );
        }
    });

    it("rejects unknown action values", () => {
        assert.equal(Value.Check(tool.parameters, { ...VALID, action: "delete" }), false);
    });

    it("rejects unknown type values", () => {
        assert.equal(Value.Check(tool.parameters, { ...VALID, type: "misc" }), false);
    });

    it("rejects oversized name/content/description", () => {
        assert.equal(Value.Check(tool.parameters, { ...VALID, name: "x".repeat(61) }), false);
        assert.equal(
            Value.Check(tool.parameters, {
                ...VALID,
                content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1),
            }),
            false,
        );
        assert.equal(
            Value.Check(tool.parameters, { ...VALID, description: "x".repeat(121) }),
            false,
        );
    });

    it("description explicitly warns against snake_case id", () => {
        // Belt-and-suspenders: the description should not steer models toward
        // snake_case. The old description ended with `e.g., 'user_role', ...`
        // which directly trained the failure pattern.
        assert.ok(tool.description.includes("kebab-case"), "description must mention kebab-case");
        assert.ok(
            !tool.description.includes("user_role"),
            "description must not include snake_case example",
        );
        assert.ok(
            tool.description.includes("Underscores"),
            "description must explicitly reject underscores",
        );
    });
});

describe("memory tool execute", () => {
    it("dispatches flat params directly to memory.upsert RPC", async () => {
        let captured: MemoryUpsertParams | undefined;
        const tool = createMemoryTool();
        const ctx: TacoToolContext = {
            env: undefined as never,
            workspace: asWorkspaceId("/tmp/ws"),
            call: async <P, R>(_method: string, _workspace: string, params: P): Promise<R> => {
                captured = params as unknown as MemoryUpsertParams;
                return { ok: true, outcome: "created" } as unknown as R;
            },
            sessionId: asSessionId("test-session"),
            sessionKind: "main",
            isIm: false,
        };

        const result = await invokeTool(tool, VALID, ctx);

        // Critical: the params handed to memory.upsert must be flat, with
        // `action` as a string — not nested under another `action` envelope.
        assert.deepEqual(captured, {
            workspace: asWorkspaceId("/tmp/ws"),
            action: "add",
            id: "web-search-preference",
            name: "Web search default",
            description: "Default to mmx-cli for web search",
            content: "Use mmx-cli skill by default.",
            type: "user",
        });
        assert.equal(
            result.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
            "memory.upsert created: web-search-preference",
        );
        assert.deepEqual(result.details, { ok: true, outcome: "created" });
    });

    it("throws clearly when ctx.call is missing", async () => {
        const tool = createMemoryTool();
        await assert.rejects(
            () =>
                invokeTool(tool, VALID, {
                    env: undefined as never,
                    workspace: asWorkspaceId("/tmp/ws"),
                    sessionId: asSessionId("test-session"),
                    sessionKind: "main",
                    isIm: false,
                } as TacoToolContext),
            /no self-RPC dispatcher/,
        );
    });
});

describe("planExit tool", () => {
    let testDir: string;
    let state: ReturnType<typeof createPlanModeState>;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-plans-test-"));
        state = createPlanModeState();
    });

    it("returns plan preview and terminates on first call", async () => {
        enterPlanMode(state, "test-plan");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "test-plan.md"), "# Plan\n\nDo stuff.\n\nMore details.");

        const tool = createPlanExitTool(state, testDir, undefined, asSessionId("test-session"));
        const result = await invokeTool(
            tool,
            { planSlug: "test-plan" },
            {
                env: new NodeExecutionEnv({ cwd: "/" }),
            },
        );

        assert.equal(result.terminate, true);
        assert.equal(result.content[0].type, "text");
        if (result.content[0].type === "text") {
            assert.match(result.content[0].text, /Do stuff/);
        }
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.questions?.[0].question, "Approve this plan?");
        assert.equal(state.active, true);

        rmSync(testDir, { recursive: true, force: true });
    });

    it("rejects if not in plan mode", async () => {
        const tool = createPlanExitTool(state, testDir, undefined, asSessionId("test-session"));
        try {
            await invokeTool(
                tool,
                { planSlug: "test-plan" },
                {
                    env: new NodeExecutionEnv({ cwd: "/" }),
                },
            );
            assert.fail("Should have thrown");
        } catch (error) {
            assert.match((error as Error).message, /Not in plan mode/);
        }

        rmSync(testDir, { recursive: true, force: true });
    });

    it("exits plan mode when user approves", async () => {
        enterPlanMode(state, "test-plan");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "test-plan.md"), "# Plan\n\nDo stuff.");

        const tool = createPlanExitTool(state, testDir, undefined, asSessionId("test-session"));
        const result = await invokeTool(
            tool,
            { planSlug: "test-plan", answers: { "Approve this plan?": "Approve" } },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tc-2" },
        );

        assert.equal(state.active, false);
        assert.equal(state.currentSlug, null);
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, true);

        rmSync(testDir, { recursive: true, force: true });
    });

    it("keeps plan mode when user rejects", async () => {
        enterPlanMode(state, "test-plan");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "test-plan.md"), "# Plan\n\nDo stuff.");

        const tool = createPlanExitTool(state, testDir, undefined, asSessionId("test-session"));
        const result = await invokeTool(
            tool,
            { planSlug: "test-plan", answers: { "Approve this plan?": "Reject" } },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tc-2" },
        );

        assert.equal(state.active, true);
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, false);

        rmSync(testDir, { recursive: true, force: true });
    });
});

describe("planExit tool — schema robustness", () => {
    let testDir: string;
    let state: ReturnType<typeof createPlanModeState>;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "taco-plans-schema-"));
        state = createPlanModeState();
    });

    it("omitting planSlug uses state.currentSlug to locate the plan file", async () => {
        enterPlanMode(state, "stored-slug");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "stored-slug.md"), "# Plan from state\n\nBody.");

        const tool = createPlanExitTool(state, testDir, undefined, asSessionId("test-session"));
        // No planSlug passed — relies entirely on state.currentSlug
        const result = await invokeTool(
            tool,
            {},
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tc" },
        );

        assert.equal(result.terminate, true);
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.questions?.[0].question, "Approve this plan?");
        assert.match(details.planContent, /Plan from state/);
        rmSync(testDir, { recursive: true, force: true });
    });

    it("second call skips readFileSync — Approve works even after .md is deleted", async () => {
        enterPlanMode(state, "ephemeral");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        const mdPath = join(plansDir, "ephemeral.md");
        writeFileSync(mdPath, "# Ephemeral");

        const tool = createPlanExitTool(state, testDir, undefined, asSessionId("test-session"));
        // Simulate user/system deleting the plan document while waiting
        rmSync(mdPath, { force: true });

        // Second call, with answers — must not throw "Plan document not found"
        const result = await invokeTool(
            tool,
            { planSlug: "ephemeral", answers: { "Approve this plan?": "Approve" } },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tc" },
        );

        assert.equal(state.active, false, "Approve should still exit plan mode");
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, true);
        assert.equal(details.planContent, "", "second-call details should not carry plan content");
        rmSync(testDir, { recursive: true, force: true });
    });

    it("second call without planSlug also works via state.currentSlug", async () => {
        enterPlanMode(state, "no-slug-2nd");
        const plansDir = join(testDir, ".taco", "plans");
        mkdirSync(plansDir, { recursive: true });
        writeFileSync(join(plansDir, "no-slug-2nd.md"), "# Body");

        const tool = createPlanExitTool(state, testDir, undefined, asSessionId("test-session"));
        // Delete .md — but because this is a second call (with answers), it still doesn't read the file
        rmSync(join(plansDir, "no-slug-2nd.md"), { force: true });

        const result = await invokeTool(
            tool,
            { answers: { "Approve this plan?": "Reject" } },
            { env: new NodeExecutionEnv({ cwd: "/" }) },
            { toolCallId: "tc" },
        );

        assert.equal(state.active, true, "Reject should keep plan mode active");
        const details = result.details as PlanExitToolDetails;
        assert.equal(details.approved, false);
        rmSync(testDir, { recursive: true, force: true });
    });
});
