import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { TaskListMeta } from "@taco-ai/protocol";
// Unit-test the shape builder the RPC handler uses.
import {
    buildHistoryListDetail,
    buildTasksGetResult,
} from "../../src/server/handlers/sessionTasksGet.ts";
import { findActiveListId } from "../../src/tasks/activeList.ts";
import { addTask, createTaskList } from "../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";

describe("session.tasks.get result shape", () => {
    it("returns active list + history meta", () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "old");
        addTask(store, "l1", { content: "done", status: "completed", activeForm: "done" });
        createTaskList(store, "l2", "active");
        addTask(store, "l2", { content: "todo", status: "pending", activeForm: "todo" });
        store.currentListId = findActiveListId(store);
        const res = buildTasksGetResult(store);
        assert.equal(res.active?.id, "l2");
        assert.equal(res.active?.tasks.length, 1);
        const hist = res.history as TaskListMeta[];
        assert.equal(hist.length, 1);
        assert.equal(hist[0]?.id, "l1");
        assert.equal(hist[0]?.completedCount, 1);
    });

    it("active is null when no unfinished tasks", () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "old");
        addTask(store, "l1", { content: "d", status: "completed", activeForm: "d" });
        store.currentListId = findActiveListId(store);
        const res = buildTasksGetResult(store);
        assert.equal(res.active, null);
        assert.equal(res.history.length, 1);
    });

    it("全 failed 视为终态:active=null 且 failed 不计入 completedCount", () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "old");
        addTask(store, "l1", { content: "a", status: "completed", activeForm: "a" });
        addTask(store, "l1", { content: "b", status: "failed", activeForm: "b" });
        store.currentListId = findActiveListId(store);
        const res = buildTasksGetResult(store);
        assert.equal(res.active, null);
        assert.equal(res.history.length, 1);
        assert.equal(res.history[0]?.completedCount, 1);
    });

    it("history 按 createdAt 倒序 — 新的在最上面", () => {
        const store = createTaskStore("/ws");
        // Intentionally scrambled creation order — verifies reverse sort is correct.
        const l1 = createTaskList(store, "l1", "first");
        l1.createdAt = "2026-01-01T00:00:00.000Z";
        const l2 = createTaskList(store, "l2", "second");
        l2.createdAt = "2026-01-02T00:00:00.000Z";
        const l3 = createTaskList(store, "l3", "third");
        l3.createdAt = "2026-01-03T00:00:00.000Z";
        // All complete → active=null → all three land in history
        for (const l of [l1, l2, l3]) {
            addTask(store, l.id, { content: "x", status: "completed", activeForm: "x" });
        }
        store.currentListId = findActiveListId(store);
        const res = buildTasksGetResult(store);
        assert.equal(res.active, null);
        assert.deepEqual(
            res.history.map((h) => h.id),
            ["l3", "l2", "l1"],
        );
    });
});

describe("session.taskHistory.get result shape", () => {
    it("按 listId 拉取完整 task 明细,只序列化 wire 字段", () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "old");
        addTask(store, "l1", { content: "a", status: "completed", activeForm: "a" });
        addTask(store, "l1", { content: "b", status: "failed", activeForm: "b" });
        const detail = buildHistoryListDetail(store, "l1");
        assert.equal(detail.length, 2);
        // Key: TaskItem wire shape has exactly 4 fields; internal createdAt/updatedAt must not leak
        assert.deepEqual(Object.keys(detail[0]).sort(), ["activeForm", "content", "id", "status"]);
    });

    it("未知 listId 返回 [] (不发错)", () => {
        const store = createTaskStore("/ws");
        assert.deepEqual(buildHistoryListDetail(store, "nonexistent"), []);
    });
});
