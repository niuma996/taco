import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { findActiveListId, isListActive } from "../../src/tasks/activeList.ts";
import { addTask, createTaskList } from "../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";

describe("isListActive / findActiveListId", () => {
    it("list with a pending task is active", () => {
        const store = createTaskStore("/ws");
        const list = createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "x", status: "pending", activeForm: "x" });
        assert.equal(isListActive(list), true);
        assert.equal(findActiveListId(store), "l1");
    });

    it("all-completed list is inactive; store with no active list returns null", () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "x", status: "completed", activeForm: "x" });
        assert.equal(findActiveListId(store), null);
    });

    it("failed 是终态:全 failed 的 list 不再活跃", () => {
        const store = createTaskStore("/ws");
        const list = createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "x", status: "failed", activeForm: "x" });
        assert.equal(isListActive(list), false);
        assert.equal(findActiveListId(store), null);
    });

    it("混合 completed + failed(无未完成)同样不活跃", () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "a", status: "completed", activeForm: "a" });
        addTask(store, "l1", { content: "b", status: "failed", activeForm: "b" });
        assert.equal(findActiveListId(store), null);
    });

    it("empty store currentListId starts null", () => {
        const store = createTaskStore("/ws");
        assert.equal(store.currentListId, null);
    });
});
