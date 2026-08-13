import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { addTask, createTaskList } from "../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";
import type { TaskList } from "../../src/tasks/taskTypes.ts";
import { createTodoWriteTool } from "../../src/tools/todoWrite.ts";
import { TEST_SESSION_ID, testTaskPublisher } from "./_helpers.ts";

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
        const result = await tool.execute(
            "tc-1",
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
            undefined,
            undefined,
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
        await tool.execute(
            "tc-1",
            {
                todos: [{ content: "Task 1", status: "pending", activeForm: "Working on task 1" }],
            },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        const firstListId = store.currentListId;
        assert.ok(firstListId);

        // Second call replaces the same active list
        await tool.execute(
            "tc-2",
            {
                todos: [{ content: "Task 2", status: "pending", activeForm: "Working on task 2" }],
            },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
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
        await tool.execute(
            "tc-1",
            {
                todos: [{ content: "new", status: "in_progress", activeForm: "new" }],
            },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
        );

        const list = scopedStore.lists.get("l1");
        assert.equal(list?.tasks.length, 1);
        assert.equal(list?.tasks[0].content, "new");
    });
});
