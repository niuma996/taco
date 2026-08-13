import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildActiveTasksContextHook } from "../../src/tasks/activeTasksTag.ts";
import { addTask, createTaskList } from "../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";
import { createPlanModeState } from "../../src/tools/planModeState.ts";

function makeState(store: ReturnType<typeof createTaskStore>, planActive: boolean) {
    return { store, planActive, planState: createPlanModeState() };
}

function ctxWith(messages: unknown[]) {
    return { messages } as never;
}

describe("active_tasks tag", () => {
    it("injects unfinished-task guidance when active list has unfinished tasks", async () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "深圳骑行");
        addTask(store, "l1", { content: "查天气", status: "pending", activeForm: "查天气" });
        store.currentListId = "l1";
        const hook = buildActiveTasksContextHook(() => makeState(store, false));
        const res = await hook(ctxWith([]));
        const text = JSON.stringify(res);
        assert.match(text, /active_tasks/);
        assert.match(text, /查天气/);
    });

    it("injects nothing when all tasks completed", async () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "x", status: "completed", activeForm: "x" });
        store.currentListId = "l1";
        const hook = buildActiveTasksContextHook(() => makeState(store, false));
        const res = await hook(ctxWith([]));
        assert.equal(res, undefined);
    });

    it("suppresses injection while plan mode is active", async () => {
        const store = createTaskStore("/ws");
        createTaskList(store, "l1", "A");
        addTask(store, "l1", { content: "x", status: "pending", activeForm: "x" });
        store.currentListId = "l1";
        const hook = buildActiveTasksContextHook(() => makeState(store, true));
        const res = await hook(ctxWith([]));
        assert.equal(res, undefined);
    });
});
