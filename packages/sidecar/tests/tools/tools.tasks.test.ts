import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { buildSessionTaskState } from "../../src/runtime/session/sessionTaskState.ts";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import { addTask, createTaskList } from "../../src/tasks/taskMutations.ts";
import { loadAllTaskLists, saveTaskListToDisk } from "../../src/tasks/taskPersistence.ts";
import { createTaskCreateTool } from "../../src/tools/taskCreate.ts";
import { createTaskListTool } from "../../src/tools/taskList.ts";
import { createTaskUpdateTool } from "../../src/tools/taskUpdate.ts";
import { createTodoWriteTool } from "../../src/tools/todoWrite.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { TEST_SESSION_ID, testTaskPublisher } from "./_helpers.ts";

const taskInput = { content: "Work", status: "pending", activeForm: "Working" } as const;
const context = { env: new NodeExecutionEnv({ cwd: "/" }) };

for (const toolName of ["taskCreate", "todoWrite"] as const) {
    it(`rejects a previous list's task ID after ${toolName} starts another list`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "taco-task-ids-"));
        try {
            const store = createTaskStore("test");
            const create = createTaskCreateTool(store, dir, testTaskPublisher(), TEST_SESSION_ID);
            const todo = createTodoWriteTool(store, dir, testTaskPublisher(), TEST_SESSION_ID);
            const update = createTaskUpdateTool(store, dir, testTaskPublisher(), TEST_SESSION_ID);
            const startList = (listName: string) =>
                toolName === "taskCreate"
                    ? invokeTool(create, { listName, tasks: [taskInput] }, context)
                    : invokeTool(todo, { todos: [taskInput] }, context);
            await startList("First");
            const first = store.lists.get(store.currentListId as string)?.tasks[0];
            assert.ok(first);
            await invokeTool(
                update,
                { taskId: first.id, updates: { status: "completed" } },
                context,
            );
            await startList("Second");
            const current = store.lists.get(store.currentListId as string);
            assert.ok(current);
            await assert.rejects(
                invokeTool(update, { taskId: first.id, updates: { status: "failed" } }, context),
                /Task not found/,
            );
            assert.notEqual(current.tasks[0].id, first.id);
            assert.equal(current.tasks[0].status, "pending");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
}

it("migrates legacy task IDs on restore and persists usable IDs through todoWrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-task-restore-"));
    try {
        const initial = await buildSessionTaskState(TEST_SESSION_ID, root);
        for (const id of ["old-list", "current-list"]) {
            const list = createTaskList(initial.taskStore, id, id);
            const task = addTask(initial.taskStore, id, {
                ...taskInput,
                status: id === "old-list" ? "completed" : "pending",
            });
            task.id = "task-1";
            await saveTaskListToDisk(initial.tasksDir, list);
            if (id === "old-list") {
                // Unversioned files are also a supported legacy format.
                const raw = JSON.parse(
                    await readFile(join(initial.tasksDir, `${id}.json`), "utf-8"),
                );
                delete raw.schemaVersion;
                await writeFile(join(initial.tasksDir, `${id}.json`), JSON.stringify(raw));
            }
        }

        const restored = await buildSessionTaskState(TEST_SESSION_ID, root);
        const store = restored.taskStore;
        const old = store.lists.get("old-list");
        const current = store.lists.get("current-list");
        assert.ok(old && current);
        assert.equal(store.currentListId, current.id);
        assert.notEqual(old.tasks[0].id, current.tasks[0].id);
        assert.notEqual(current.tasks[0].id, "task-1");
        assert.equal(current.metadata.nextTaskId, 2);
        assert.equal(current.tasks[0].content, taskInput.content);
        const update = createTaskUpdateTool(
            store,
            restored.tasksDir,
            testTaskPublisher(),
            TEST_SESSION_ID,
        );
        for (const taskId of ["task-1", old.tasks[0].id]) {
            await assert.rejects(
                invokeTool(update, { taskId, updates: { status: "failed" } }, context),
                /Task not found/,
            );
        }
        const listed = await invokeTool(createTaskListTool(store), {}, context);
        assert.ok(JSON.stringify(listed.content).includes(current.tasks[0].id));
        const originalId = current.tasks[0].id;
        await invokeTool(
            update,
            { taskId: originalId, updates: { status: "in_progress" } },
            context,
        );
        const persisted = await loadAllTaskLists(restored.tasksDir);
        assert.equal(persisted.find((list) => list.id === current.id)?.tasks[0].id, originalId);
        assert.equal(
            persisted.find((list) => list.id === current.id)?.tasks[0].status,
            "in_progress",
        );

        const todo = createTodoWriteTool(
            store,
            restored.tasksDir,
            testTaskPublisher(),
            TEST_SESSION_ID,
        );
        await invokeTool(todo, { todos: [taskInput] }, context);
        const replacementId = current.tasks[0].id;
        assert.notEqual(replacementId, originalId);
        await assert.rejects(
            invokeTool(update, { taskId: originalId, updates: { status: "failed" } }, context),
            /Task not found/,
        );
        const reattached = await buildSessionTaskState(TEST_SESSION_ID, root);
        const replacement = reattached.taskStore.lists.get(current.id)?.tasks[0];
        assert.equal(replacement?.id, replacementId);
        assert.equal(reattached.taskStore.lists.get("old-list")?.tasks[0].id, old.tasks[0].id);
        await invokeTool(
            createTaskUpdateTool(
                reattached.taskStore,
                restored.tasksDir,
                testTaskPublisher(),
                TEST_SESSION_ID,
            ),
            { taskId: replacementId, updates: { status: "completed" } },
            context,
        );
        assert.equal(replacement?.status, "completed");
        assert.equal(reattached.taskStore.currentListId, null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
