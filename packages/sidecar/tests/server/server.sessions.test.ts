/** Consolidated from 2 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskListMeta } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import {
    buildHistoryListDetail,
    buildTasksGetResult,
} from "../../src/server/handlers/sessionTasksGet.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { findActiveListId } from "../../src/tasks/activeList.ts";
import { createTaskStore } from "../../src/tasks/createTaskStore.ts";
import { addTask, createTaskList } from "../../src/tasks/taskMutations.ts";

describe("sessionSnapshot", () => {
    describe("session.snapshot.get", () => {
        it("retries until the history and main-session state share a stable sequence watermark", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            const taskStore = createTaskStore("/workspace");
            const attached = {
                taskStore,
                planState: { active: true, currentSlug: "plan-1" },
            };
            let historyReads = 0;
            const sequenceSamples = [4, 5, 6, 6];
            server.ensureWorkspace = async () =>
                ({
                    listSessions: async () => [{ id: "main", metadata: { kind: "main" } }],
                    getSessionFacts: async (id: string) => (id === "main" ? { kind: "main" } : {}),
                    getHistory: async () => {
                        historyReads++;
                        return {
                            leafEntryId: null,
                            entries: [
                                {
                                    id: "entry-1",
                                    parentId: null,
                                    type: "message",
                                    message: { role: "assistant", content: "hello" },
                                    timestamp: "2026-08-01T00:00:00.000Z",
                                },
                            ],
                        };
                    },
                    getAttached: () => attached,
                    attach: async () => assert.fail("attached session should be reused"),
                }) as never;
            server.getSessionLastSeq = () => sequenceSamples.shift() ?? 6;

            const response = await server.dispatchRpc({
                id: "snapshot-main",
                method: "session.snapshot.get",
                params: { workspace: "/workspace", sessionId: "main" },
            });

            assert.deepEqual(response, {
                id: "snapshot-main",
                ok: true,
                result: {
                    sessionId: "main",
                    sessionKind: "main",
                    snapshotSeq: 6,
                    history: {
                        sessionId: "main",
                        leafEntryId: null,
                        entries: [
                            {
                                id: "entry-1",
                                parentId: null,
                                type: "message",
                                payload: { role: "assistant", content: "hello" },
                                timestamp: "2026-08-01T00:00:00.000Z",
                            },
                        ],
                    },
                    tasks: { active: null, history: [] },
                    planState: { active: true, currentSlug: "plan-1" },
                },
            });
            assert.equal(historyReads, 2);
        });

        it("returns a subagent history snapshot without attaching main-session tools", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            let attachCalls = 0;
            server.ensureWorkspace = async () =>
                ({
                    listSessions: async () => [{ id: "child", metadata: { kind: "subagent" } }],
                    getSessionFacts: async (id: string) =>
                        id === "child" ? { kind: "subagent" } : {},
                    getHistory: async () => ({ leafEntryId: null, entries: [] }),
                    getAttached: () => undefined,
                    attach: async () => {
                        attachCalls++;
                        return assert.fail("subagent snapshots must not attach main-session tools");
                    },
                }) as never;
            server.getSessionLastSeq = () => 3;

            const response = await server.dispatchRpc({
                id: "snapshot-child",
                method: "session.snapshot.get",
                params: { workspace: "/workspace", sessionId: "child" },
            });

            assert.deepEqual(response, {
                id: "snapshot-child",
                ok: true,
                result: {
                    sessionId: "child",
                    sessionKind: "subagent",
                    snapshotSeq: 3,
                    history: { sessionId: "child", leafEntryId: null, entries: [] },
                },
            });
            assert.equal(attachCalls, 0);
        });

        it("resolves the session kind by exact id, not a prefix match", async () => {
            // Two sessions where one id is a prefix of the requested id. A
            // startsWith() lookup would misclassify the requested main session as
            // the subagent whose id happens to be its prefix.
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            let attachCalls = 0;
            server.ensureWorkspace = async () =>
                ({
                    listSessions: async () => [
                        { id: "0199", metadata: { kind: "subagent" } },
                        { id: "0199abcd", metadata: { kind: "main" } },
                    ],
                    getSessionFacts: async (id: string) => {
                        if (id === "0199") return { kind: "subagent" };
                        if (id === "0199abcd") return { kind: "main" };
                        return {};
                    },
                    getHistory: async () => ({ leafEntryId: null, entries: [] }),
                    getAttached: () => ({
                        taskStore: createTaskStore("/workspace"),
                        planState: { active: false, currentSlug: null },
                    }),
                    attach: async () => {
                        attachCalls++;
                        return assert.fail("main session should be reused, not re-attached");
                    },
                }) as never;
            server.getSessionLastSeq = () => 2;

            const response = await server.dispatchRpc({
                id: "snapshot-exact",
                method: "session.snapshot.get",
                params: { workspace: "/workspace", sessionId: "0199abcd" },
            });

            assert.equal(response.ok, true);
            assert.equal(
                (response as { result: { sessionKind: string } }).result.sessionKind,
                "main",
            );
            assert.equal(attachCalls, 0);
        });

        it("resolves a unique short id as a subagent without attaching main-session tools", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            let attachCalls = 0;
            server.ensureWorkspace = async () =>
                ({
                    listSessions: async () => [
                        { id: "child-full-id", metadata: { kind: "subagent" } },
                    ],
                    getSessionFacts: async (id: string) =>
                        id === "child-full-id" ? { kind: "subagent" } : {},
                    getHistory: async () => ({ leafEntryId: null, entries: [] }),
                    getAttached: () => undefined,
                    attach: async () => {
                        attachCalls++;
                        return assert.fail("subagent snapshots must not attach main-session tools");
                    },
                }) as never;
            server.getSessionLastSeq = () => 3;

            const response = await server.dispatchRpc({
                id: "snapshot-child-short-id",
                method: "session.snapshot.get",
                params: { workspace: "/workspace", sessionId: "child" },
            });

            assert.equal(response.ok, true);
            assert.equal(
                (response as { result: { sessionKind: string } }).result.sessionKind,
                "subagent",
            );
            assert.equal(attachCalls, 0);
        });

        it("rejects an ambiguous short id instead of guessing a session kind", async () => {
            const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
            server.ensureWorkspace = async () =>
                ({
                    listSessions: async () => [
                        { id: "child-a", metadata: { kind: "subagent" } },
                        { id: "child-b", metadata: { kind: "main" } },
                    ],
                    getSessionFacts: async () => assert.fail("ambiguous ids must not read facts"),
                    getHistory: async () => assert.fail("ambiguous ids must not read history"),
                    getAttached: () => assert.fail("ambiguous ids must not read attached state"),
                    attach: async () => assert.fail("ambiguous ids must not attach"),
                }) as never;

            const response = await server.dispatchRpc({
                id: "snapshot-ambiguous-short-id",
                method: "session.snapshot.get",
                params: { workspace: "/workspace", sessionId: "child" },
            });

            assert.deepEqual(response, {
                id: "snapshot-ambiguous-short-id",
                ok: false,
                error: {
                    code: "invalid_params",
                    message: "session id prefix is ambiguous: child",
                    data: undefined,
                },
            });
        });
    });
});

describe("sessionRpc", () => {
    // Unit-test the shape builder the RPC handler uses.

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
            assert.deepEqual(Object.keys(detail[0]).sort(), [
                "activeForm",
                "content",
                "id",
                "status",
            ]);
        });
    });
});
