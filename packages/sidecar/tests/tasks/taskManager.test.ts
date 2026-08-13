import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { addTask, createTaskList, updateTask } from "../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";

describe("taskManager", () => {
    it("should create a new task list", () => {
        const store = createTaskStore("test-session");
        const list = createTaskList(store, "test-list", "Test List");
        assert.equal(list.id, "test-list");
        assert.equal(list.name, "Test List");
        assert.equal(list.tasks.length, 0);
        assert.equal(list.metadata.nextTaskId, 1);
    });

    it("should add a task to a list", () => {
        const store = createTaskStore("test-session");
        const _list = createTaskList(store, "test-list", "Test List");
        const task = addTask(store, "test-list", {
            content: "Test task",
            status: "pending",
            activeForm: "Testing task",
        });
        assert.equal(task.id, "task-1");
        assert.equal(task.content, "Test task");
        assert.equal(task.status, "pending");
    });

    it("should update a task", () => {
        const store = createTaskStore("test-session");
        const _list = createTaskList(store, "test-list", "Test List");
        const task = addTask(store, "test-list", {
            content: "Test task",
            status: "pending",
            activeForm: "Testing task",
        });
        const updated = updateTask(store, "test-list", task.id, {
            status: "completed",
        });
        assert.equal(updated.status, "completed");
    });
});
