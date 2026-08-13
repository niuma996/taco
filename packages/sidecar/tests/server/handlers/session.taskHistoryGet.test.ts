/**
 * session.taskHistory.get handler tests.
 *
 * Key behaviours:
 *   - When not attached: auto-attach (so disk hydrate runs), then read from
 *     the attached store. Must not return [] directly — that would misread
 *     as an "empty list" to the UI.
 *   - Unknown listId → returns [] (empty list is also a valid value).
 *   - Already attached → does not re-attach.
 */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { addTask, createTaskList } from "../../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../../src/tasks/taskStore.ts";
import type { TaskStore } from "../../../src/tasks/taskTypes.ts";

before(() => {
    registerBuiltinMethods();
});

describe("session.taskHistory.get handler", () => {
    it("未 attach 时自动 attach,然后从 hydrated store 读取 listId", async () => {
        const store: TaskStore = createTaskStore("/ws");
        const list = createTaskList(store, "L-x", "原 list");
        addTask(store, "L-x", {
            content: "已完成的 task",
            status: "completed",
            activeForm: "f",
        });

        let attachCalls = 0;
        const attached = { taskStore: store };
        const workspace = {
            getAttached(_sid: string) {
                return undefined;
            },
            async attach(_sid: string) {
                attachCalls++;
                return attached;
            },
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: { workspace: "/tmp/ws", sessionId: "sid-1", listId: "L-x" },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
        const handler = getRegisteredMethod("session.taskHistory.get");
        assert.ok(handler);
        const out = (await handler.handler(ctx)) as Array<{ id: string }>;
        assert.equal(out.length, 1);
        assert.equal(out[0]?.id, list.tasks[0]?.id);
        assert.equal(attachCalls, 1, "auto-attach 触发了一次");
    });

    it("已 attach 时直接读 attached.taskStore,不重复 attach", async () => {
        let attachCalls = 0;
        const store: TaskStore = createTaskStore("/ws");
        const attached = { taskStore: store };
        const workspace = {
            getAttached(_sid: string) {
                return attached;
            },
            async attach(_sid: string) {
                attachCalls++;
                throw new Error("should not be called when already attached");
            },
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: { workspace: "/tmp/ws", sessionId: "sid-1", listId: "L-y" },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
        const handler = getRegisteredMethod("session.taskHistory.get");
        assert.ok(handler);
        await handler.handler(ctx);
        assert.equal(attachCalls, 0, "未重复 attach");
    });

    it("找不到 listId 时返回 []", async () => {
        const store: TaskStore = createTaskStore("/ws");
        const attached = { taskStore: store };
        const workspace = {
            getAttached(_sid: string) {
                return attached;
            },
            async attach() {
                throw new Error("not used");
            },
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: { workspace: "/tmp/ws", sessionId: "sid-1", listId: "不存在" },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
        const handler = getRegisteredMethod("session.taskHistory.get");
        assert.ok(handler);
        const out = (await handler.handler(ctx)) as unknown[];
        assert.deepEqual(out, []);
    });
});
