/**
 * todoWriteReminder — unit tests.
 *
 * Run: pnpm --filter @taco-ai/sidecar test
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage, ContextEvent } from "@earendil-works/pi-agent-core";

import { addTask, createTaskList } from "../../src/tasks/taskManager.ts";
import { createTaskStore } from "../../src/tasks/taskStore.ts";
import { buildTodoWriteReminderContextHook } from "../../src/tasks/todoWriteReminder.ts";

function userMsg(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** Assistant message with plain text (no tool calls). */
function assistantText(text: string): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
    } as unknown as AgentMessage;
}

/** Assistant message that includes a todoWrite tool call. */
function assistantTodoWrite(): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "todoWrite", arguments: {} }],
    } as unknown as AgentMessage;
}

/** Build a store with one active list holding a single task of the given status. */
function storeWithTask(status: "pending" | "completed") {
    const store = createTaskStore("/ws");
    createTaskList(store, "l1", "L");
    addTask(store, "l1", { content: "x", status, activeForm: "x" });
    store.currentListId = "l1";
    return store;
}

describe("buildTodoWriteReminderContextHook", () => {
    it("does not remind when there are no unfinished tasks", () => {
        const store = storeWithTask("completed");
        const hook = buildTodoWriteReminderContextHook(() => store);
        const msgs = Array.from({ length: 15 }, (_, i) => assistantText(`turn ${i}`));
        assert.equal(hook({ messages: msgs } as ContextEvent), undefined);
    });

    it("does not remind when there is no active list", () => {
        const store = createTaskStore("/ws");
        const hook = buildTodoWriteReminderContextHook(() => store);
        const msgs = Array.from({ length: 15 }, (_, i) => assistantText(`turn ${i}`));
        assert.equal(hook({ messages: msgs } as ContextEvent), undefined);
    });

    it("does not remind before the turn threshold", () => {
        const store = storeWithTask("pending");
        const hook = buildTodoWriteReminderContextHook(() => store);
        // 9 assistant turns < TURNS_BETWEEN_REMINDERS (10)
        const msgs = Array.from({ length: 9 }, (_, i) => assistantText(`turn ${i}`));
        assert.equal(hook({ messages: msgs } as ContextEvent), undefined);
    });

    it("reminds after 10+ assistant turns without a todoWrite call", () => {
        const store = storeWithTask("pending");
        const hook = buildTodoWriteReminderContextHook(() => store);
        const msgs = Array.from({ length: 12 }, (_, i) => assistantText(`turn ${i}`));
        const res = hook({ messages: msgs } as ContextEvent);
        assert.ok(res, "should remind");
        assert.match(JSON.stringify(res), /todo_reminder/);
    });

    it("resets the streak when a recent todoWrite call is present", () => {
        const store = storeWithTask("pending");
        const hook = buildTodoWriteReminderContextHook(() => store);
        // 12 turns, but the most recent one used todoWrite → streak = 0.
        const msgs: AgentMessage[] = Array.from({ length: 11 }, (_, i) => assistantText(`t${i}`));
        msgs.push(assistantTodoWrite());
        assert.equal(hook({ messages: msgs } as ContextEvent), undefined);
    });

    it("stops counting at the first user message (turn boundary)", () => {
        const store = storeWithTask("pending");
        const hook = buildTodoWriteReminderContextHook(() => store);
        // Only 3 assistant turns since the last user message → below threshold,
        // even though older history is long.
        const msgs: AgentMessage[] = [
            ...Array.from({ length: 20 }, (_, i) => assistantText(`old ${i}`)),
            userMsg("new user turn"),
            assistantText("a"),
            assistantText("b"),
            assistantText("c"),
        ];
        assert.equal(hook({ messages: msgs } as ContextEvent), undefined);
    });
});
