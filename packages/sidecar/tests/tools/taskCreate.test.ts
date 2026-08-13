import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { addTask, createTaskList } from "../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";
import { createTaskCreateTool } from "../../src/tools/taskCreate.ts";
import { TEST_SESSION_ID, testTaskPublisher } from "./_helpers.ts";

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
        const result = await tool.execute(
            "tc-1",
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
            undefined,
            undefined,
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

        const result = await tool.execute(
            "tc-2",
            {
                listName: "Sprint 2",
                tasks: [{ content: "Task 2", status: "pending", activeForm: "Working on task 2" }],
            },
            undefined,
            undefined,
            { env: new NodeExecutionEnv({ cwd: "/" }) },
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
        const result = await tool.execute(
            "tc-1",
            {
                listName: "Sprint 3",
                tasks: [
                    { content: "First", status: "pending", activeForm: "Doing first" },
                    { content: "Second", status: "in_progress", activeForm: "Doing second" },
                ],
            },
            undefined,
            undefined,
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
