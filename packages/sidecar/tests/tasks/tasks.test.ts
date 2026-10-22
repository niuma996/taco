import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import type { ContextEvent } from "../../src/extensions/types.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { findActiveListId, isListActive } from "../../src/tasks/activeList.ts";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import { sessionTasksDir } from "../../src/tasks/sessionTasksDir.ts";
import { addTask, createTaskList } from "../../src/tasks/taskMutations.ts";
import { loadAllTaskLists, saveTaskListToDisk } from "../../src/tasks/taskPersistence.ts";
import { TaskPushAdapter } from "../../src/tasks/taskPushAdapter.ts";
import type { TaskStore } from "../../src/tasks/taskTypes.ts";
import { buildTodoWriteReminderContextHook } from "../../src/tasks/todoWriteReminder.ts";

describe("activeList", () => {
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
});

describe("sessionTasksDir", () => {
    describe("sessionTasksDir", () => {
        it("is scoped under the caller-supplied sessionsRoot, TACO_HOME-aware", () => {
            // Regression: hardcoded homedir() ignored TACO_HOME, splitting session
            // data and task state onto different roots — attach would hydrate an
            // empty task list.
            for (const sessionsRoot of ["/var/taco/sessions", "/srv/taco/sessions"]) {
                const dir = sessionTasksDir(asSessionId("abc-123"), sessionsRoot);
                // Path is joined with `path.join`, so use `join` here too — the
                // original assertion hard-coded POSIX "/" and broke on Windows.
                assert.equal(dir, join(sessionsRoot, "abc-123", "tasks"));
            }
        });
    });

    describe("loadAllTaskLists", () => {
        it("loads every persisted list in the dir", async () => {
            const base = await mkdtemp(join(tmpdir(), "taco-tasks-"));
            try {
                const store = createTaskStore("/ws");
                const l1 = createTaskList(store, "l1", "A");
                addTask(store, "l1", { content: "x", status: "completed", activeForm: "x" });
                const l2 = createTaskList(store, "l2", "B");
                await saveTaskListToDisk(base, l1);
                await saveTaskListToDisk(base, l2);
                const loaded = await loadAllTaskLists(base);
                assert.equal(loaded.length, 2);
            } finally {
                await rm(base, { recursive: true, force: true });
            }
        });

        it("returns [] for a missing dir", async () => {
            const loaded = await loadAllTaskLists(join(tmpdir(), "taco-does-not-exist-xyz"));
            assert.deepEqual(loaded, []);
        });
    });
});

describe("taskPushAdapter", () => {
    describe("TaskPushAdapter", () => {
        it("publishes tasks.updated push frame with active list", () => {
            const captured: Array<{
                method: string;
                workspace: string;
                session: string;
                params: unknown;
            }> = [];
            const adapter = new TaskPushAdapter((method, workspace, session, params) => {
                captured.push({ method, workspace, session, params });
            });

            const store: TaskStore = {
                currentListId: "default-test",
                lists: new Map([
                    [
                        "default-test",
                        {
                            id: "default-test",
                            name: "Default Tasks",
                            tasks: [
                                {
                                    id: "1",
                                    content: "First",
                                    status: "pending",
                                    activeForm: "Working",
                                    createdAt: "",
                                    updatedAt: "",
                                },
                            ],
                            metadata: { nextTaskId: 2 },
                            createdAt: "",
                            updatedAt: "",
                        },
                    ],
                ]),
            };
            adapter.publishTasksUpdated(asWorkspaceId("ws1"), asSessionId("sess1"), store);

            assert.equal(captured.length, 1);
            assert.equal(captured[0].method, "tasks.updated");
            // cwd via push frame's workspace field, not duplicated in params (single source of truth)
            assert.equal(captured[0].workspace, "ws1");
            assert.equal(captured[0].session, "sess1");
            const params = captured[0].params as {
                sessionId: string;
                active: unknown;
                history: unknown;
            };
            assert.equal(params.sessionId, "sess1");
            assert.ok(
                params.active !== null,
                "active should not be null when list has pending tasks",
            );
            assert.equal("cwd" in params, false, "params should not carry cwd");
        });

        it("routes cwd via push frame workspace, sessionId via params", () => {
            const captured: Array<{ workspace: string; session: string; params: unknown }> = [];
            const adapter = new TaskPushAdapter((_method, workspace, session, params) => {
                captured.push({ workspace, session, params });
            });

            const store: TaskStore = {
                currentListId: null,
                lists: new Map(),
            };
            adapter.publishTasksUpdated(asWorkspaceId("ws-x"), asSessionId("sess-y"), store);

            // Route split: workspace in frame, sessionId in params (each is the single source of truth).
            assert.equal(captured[0].workspace, "ws-x");
            const params = captured[0].params as { sessionId: string; active: unknown };
            assert.equal(params.sessionId, "sess-y");
            assert.equal(params.active, null);
        });
    });
});

describe("todoWriteReminder", () => {
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
            const msgs: AgentMessage[] = Array.from({ length: 11 }, (_, i) =>
                assistantText(`t${i}`),
            );
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
});
