import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import { addTask, createTaskList } from "../../src/tasks/taskMutations.ts";
import { createTaskUpdateTool } from "../../src/tools/taskUpdate.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { TEST_SESSION_ID, testTaskPublisher } from "./_helpers.ts";

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
