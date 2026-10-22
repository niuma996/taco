/** Consolidated from 4 test files; behaviour unchanged. */

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import type { SessionListEntry } from "@taco-ai/protocol";
import {
    asSessionId,
    asWorkspaceId,
    SESSION_LIST_DEFAULT_LIMIT,
    SESSION_LIST_MAX_LIMIT,
} from "@taco-ai/protocol";
import { LaneBusy } from "../../../src/runtime/pi/values.ts";
import {
    findCursorIndex,
    normalizeLimit,
    sortSessionsDesc,
} from "../../../src/server/handlers/sessionLifecycle.ts";
import { getRegisteredMethod, RpcHandlerError } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { createTaskStore } from "../../../src/tasks/createTaskStore.ts";
import { addTask, createTaskList } from "../../../src/tasks/taskMutations.ts";
import type { TaskStore } from "../../../src/tasks/taskTypes.ts";

describe("session.compactionHandlers", () => {
    /**
     * session.compact / session.contextInfo handler tests.
     *
     * Covers two paths:
     *   - "not attached → invalid_state" — workspace.getAttached returns undefined
     *   - "attached → handler directly forwards to AttachedSession.compact / getContextInfo"
     *
     * Uses stub workspace + stub attached to avoid introducing real pi harness / provider
     * heavy dependencies. Integration tests are in attachedSession.compaction.test.ts.
     */

    before(() => {
        registerBuiltinMethods();
    });

    /** Build a MethodCtx whose workspace.getAttached returns undefined, so the
     *  handler must short-circuit with invalid_state before any AttachedSession
     *  method runs. */
    function makeNotAttachedCtx(): Parameters<
        NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
    >[0] {
        const workspace = { getAttached: () => undefined };
        return {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {},
            params: { workspace: "/tmp/ws", sessionId: "sid" },
        } as unknown as Parameters<
            NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
        >[0];
    }

    /** Drive a handler that should reject with RpcHandlerError("invalid_state"). */
    async function expectInvalidStateNotAttached(method: string): Promise<void> {
        const handler = getRegisteredMethod(method);
        assert.ok(handler, `${method} handler must be registered`);
        await assert.rejects(handler.handler(makeNotAttachedCtx()), (e: unknown) => {
            return (
                e instanceof RpcHandlerError &&
                e.code === "invalid_state" &&
                /not attached/i.test(e.message)
            );
        });
    }

    describe("session.compact handler", () => {
        it("returns invalid_state when session is not attached", async () => {
            await expectInvalidStateNotAttached("session.compact");
        });

        it("forwards to AttachedSession.compact when attached", async () => {
            let capturedInstructions: string | undefined;
            let calledCount = 0;
            const attached = {
                async compact(customInstructions?: string) {
                    calledCount++;
                    capturedInstructions = customInstructions;
                    return { ok: true, tokensBefore: 12345, fromHook: true };
                },
            };
            const workspace = {
                getAttached() {
                    return attached;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: {
                    workspace: "/tmp/ws",
                    sessionId: "sid",
                    customInstructions: "be terse",
                },
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.compact");
            assert.ok(handler);
            const out = (await handler.handler(ctx)) as {
                ok: boolean;
                tokensBefore?: number;
                fromHook?: boolean;
            };
            assert.equal(out.ok, true);
            assert.equal(out.tokensBefore, 12345);
            assert.equal(out.fromHook, true);
            assert.equal(calledCount, 1);
            assert.equal(capturedInstructions, "be terse");
        });

        it("omits customInstructions in forwarded params when not provided", async () => {
            const attached = {
                async compact(customInstructions?: string) {
                    assert.equal(customInstructions, undefined);
                    return { ok: true };
                },
            };
            const workspace = {
                getAttached() {
                    return attached;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: { workspace: "/tmp/ws", sessionId: "sid" },
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.compact");
            assert.ok(handler);
            await handler.handler(ctx);
        });
    });

    describe("session.contextInfo handler", () => {
        it("returns invalid_state when session is not attached", async () => {
            await expectInvalidStateNotAttached("session.contextInfo");
        });

        it("forwards to AttachedSession.getContextInfo and returns its shape", async () => {
            const sample = {
                modelId: "claude-sonnet",
                provider: "anthropic",
                contextWindow: 200000,
                usedTokens: 50000,
                ratio: 0.25,
                lastCompactionAt: "2026-07-25T00:00:00.000Z",
            };
            const attached = {
                async getContextInfo() {
                    return sample;
                },
            };
            const workspace = {
                getAttached() {
                    return attached;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: { workspace: "/tmp/ws", sessionId: "sid" },
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.contextInfo");
            assert.ok(handler);
            const out = await handler.handler(ctx);
            assert.deepEqual(out, sample);
        });

        it("omits lastCompactionAt when session has no prior compactions", async () => {
            const attached = {
                async getContextInfo() {
                    return {
                        modelId: "m",
                        provider: "p",
                        contextWindow: 100,
                        usedTokens: 10,
                        ratio: 0.1,
                    };
                },
            };
            const workspace = {
                getAttached() {
                    return attached;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: { workspace: "/tmp/ws", sessionId: "sid" },
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.contextInfo");
            assert.ok(handler);
            const out = (await handler.handler(ctx)) as {
                lastCompactionAt?: string;
            };
            assert.equal(out.lastCompactionAt, undefined);
        });
    });
});

describe("session.list", () => {
    /**
     * session.list kind filter logic — verifies main sessions are shown and subagent
     * sessions are hidden, exposing metadata fields.
     *
     * Uses a stub workspace (listSessions returns handwritten metadata) to drive the
     * real session.list handler, asserting correct filter (main only) and field
     * mapping. No model / real harness required.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/session.list.test.ts
     */

    before(() => {
        registerBuiltinMethods();
    });

    /** Minimal SessionListEntry for the pure-function tests below. */
    function entry(
        id: string,
        updatedAt?: string,
        createdAt = "2026-01-01T00:00:00Z",
    ): SessionListEntry {
        return {
            id: asSessionId(id),
            cwd: asWorkspaceId("/ws"),
            filePath: `/ws/${id}.jsonl`,
            createdAt,
            updatedAt,
        };
    }

    describe("session.list kind filter", () => {
        it("hides subagent sessions and surfaces metadata fields for main sessions", async () => {
            const fakeList = [
                {
                    id: "main-legacy",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/main-legacy.jsonl",
                    createdAt: "2026-01-01T00:00:00Z",
                    metadata: undefined,
                },
                {
                    id: "main-2",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/main-2.jsonl",
                    createdAt: "2026-01-02T00:00:00Z",
                    metadata: { kind: "main" },
                },
                {
                    id: "child-1",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/child-1.jsonl",
                    createdAt: "2026-01-03T00:00:00Z",
                    metadata: {
                        kind: "subagent",
                        agentType: "explorer",
                        parentSessionId: "main-2",
                        parentToolCallId: "tc1",
                        depth: 1,
                    },
                },
            ];

            const workspace = {
                async listSessions() {
                    return fakeList;
                },
                async getSessionName() {
                    return undefined;
                },
                async getSessionFacts(id: string) {
                    const row = fakeList.find((r: { id: string }) => r.id === id);
                    return row?.metadata ?? {};
                },
                async getSessionActivityAt() {
                    return undefined;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: {},
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];

            const handler = getRegisteredMethod("session.list");
            assert.ok(handler, "session.list should be registered");

            const result = (await handler.handler(ctx)) as {
                workspace: string;
                sessions: Array<{
                    id: string;
                    kind: string;
                    agentType?: string;
                    parentSessionId?: string;
                    parentToolCallId?: string;
                    depth?: number;
                }>;
            };

            // Subagents are hidden; only two main sessions remain
            assert.equal(result.sessions.length, 2);
            assert.ok(result.sessions.find((s) => s.id === "main-legacy"));
            assert.ok(result.sessions.find((s) => s.id === "main-2"));
            assert.ok(!result.sessions.find((s) => s.id === "child-1"));

            // Records without metadata default to kind = "main"; subagent fields are absent
            const legacy = result.sessions.find((s) => s.id === "main-legacy");
            assert.ok(legacy);
            assert.equal(legacy.kind, "main");
            assert.equal(legacy.agentType, undefined);
            assert.equal(legacy.parentSessionId, undefined);
            assert.equal(legacy.parentToolCallId, undefined);
            assert.equal(legacy.depth, undefined);
        });

        it("hides a facts-less session whose header already has parentSessionId", async () => {
            // The create→writeSessionFacts window: repo.create stamps
            // parentSessionId atomically, facts are still {}. Treating "no kind"
            // as main would leak the child into the sidebar.
            const fakeList = [
                {
                    id: "main-1",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/main-1.jsonl",
                    createdAt: "2026-01-01T00:00:00Z",
                },
                {
                    id: "orphan-child",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/orphan-child.jsonl",
                    createdAt: "2026-01-02T00:00:00Z",
                    parentSessionId: "main-1",
                },
            ];
            const workspace = {
                async listSessions() {
                    return fakeList;
                },
                async getSessionName() {
                    return undefined;
                },
                async getSessionFacts() {
                    return {};
                },
                async getSessionActivityAt() {
                    return undefined;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: {},
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.list");
            assert.ok(handler);
            const result = (await handler.handler(ctx)) as {
                sessions: Array<{ id: string }>;
            };
            assert.equal(result.sessions.length, 1);
            assert.equal(result.sessions[0]?.id, "main-1");
        });

        it("hides a v3-restored session whose facts carry parentSessionId but no kind", async () => {
            const fakeList = [
                {
                    id: "main-1",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/main-1.jsonl",
                    createdAt: "2026-01-01T00:00:00Z",
                },
                {
                    id: "restored-child",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/restored-child.jsonl",
                    createdAt: "2026-01-02T00:00:00Z",
                },
            ];
            const workspace = {
                async listSessions() {
                    return fakeList;
                },
                async getSessionName() {
                    return undefined;
                },
                async getSessionFacts(id: string) {
                    if (id === "restored-child") return { parentSessionId: "main-1" };
                    return {};
                },
                async getSessionActivityAt() {
                    return undefined;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: {},
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.list");
            assert.ok(handler);
            const result = (await handler.handler(ctx)) as {
                sessions: Array<{ id: string }>;
            };
            assert.equal(result.sessions.length, 1);
            assert.equal(result.sessions[0]?.id, "main-1");
        });
    });

    describe("session.list updatedAt", () => {
        it("uses last-message time, not file mtime, and falls back to createdAt", async () => {
            const activityMs = Date.UTC(2026, 7, 13, 16, 17, 40);
            const createdMs = Date.UTC(2026, 0, 1);
            const rewrittenMtime = Date.UTC(2026, 8, 18, 16, 52, 10);
            const fakeList = [
                {
                    id: "with-message",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/with-message.jsonl",
                    createdAt: createdMs,
                    modifiedAt: rewrittenMtime,
                },
                {
                    id: "empty",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/empty.jsonl",
                    createdAt: createdMs,
                    modifiedAt: Date.UTC(2026, 8, 18, 16, 52, 10),
                },
            ];
            const workspace = {
                async listSessions() {
                    return fakeList;
                },
                async getSessionName() {
                    return undefined;
                },
                async getSessionFacts() {
                    return {};
                },
                async getSessionActivityAt(id: string) {
                    return id === "with-message" ? activityMs : undefined;
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: { full: true },
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.list");
            assert.ok(handler);
            const result = (await handler.handler(ctx)) as {
                sessions: Array<{ id: string; updatedAt: string; createdAt: string }>;
            };
            const withMessage = result.sessions.find((s) => s.id === "with-message");
            const empty = result.sessions.find((s) => s.id === "empty");
            assert.ok(withMessage);
            assert.ok(empty);
            assert.equal(withMessage.updatedAt, new Date(activityMs).toISOString());
            assert.equal(empty.updatedAt, new Date(createdMs).toISOString());
            assert.notEqual(withMessage.updatedAt, new Date(rewrittenMtime).toISOString());
        });

        it("falls back to createdAt when getSessionActivityAt throws", async () => {
            const createdMs = Date.UTC(2026, 0, 1);
            const fakeList = [
                {
                    id: "broken",
                    cwd: "/tmp/ws",
                    path: "/tmp/ws/broken.jsonl",
                    createdAt: createdMs,
                },
            ];
            const workspace = {
                async listSessions() {
                    return fakeList;
                },
                async getSessionName() {
                    return undefined;
                },
                async getSessionFacts() {
                    return {};
                },
                async getSessionActivityAt() {
                    throw new Error("stream failed");
                },
            };
            const ctx = {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params: { full: true },
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
            const handler = getRegisteredMethod("session.list");
            assert.ok(handler);
            const result = (await handler.handler(ctx)) as {
                sessions: Array<{ id: string; updatedAt: string }>;
            };
            assert.equal(result.sessions[0]?.updatedAt, new Date(createdMs).toISOString());
        });
    });

    describe("normalizeLimit", () => {
        it("defaults when limit is absent or non-positive", () => {
            assert.equal(normalizeLimit(undefined), SESSION_LIST_DEFAULT_LIMIT);
            assert.equal(normalizeLimit(0), SESSION_LIST_DEFAULT_LIMIT);
            assert.equal(normalizeLimit(-5), SESSION_LIST_DEFAULT_LIMIT);
        });

        it("passes through in-range values and clamps above the max", () => {
            assert.equal(normalizeLimit(1), 1);
            assert.equal(normalizeLimit(50), 50);
            assert.equal(normalizeLimit(SESSION_LIST_MAX_LIMIT), SESSION_LIST_MAX_LIMIT);
            assert.equal(normalizeLimit(10_000), SESSION_LIST_MAX_LIMIT);
        });
    });

    describe("sortSessionsDesc", () => {
        it("orders by updatedAt desc and does not mutate the input", () => {
            const input = [
                entry("a", "2026-01-01T00:00:00Z"),
                entry("b", "2026-03-01T00:00:00Z"),
                entry("c", "2026-02-01T00:00:00Z"),
            ];
            assert.deepEqual(
                sortSessionsDesc(input).map((s) => s.id),
                ["b", "c", "a"],
            );
            assert.deepEqual(
                input.map((s) => s.id),
                ["a", "b", "c"],
            );
        });

        it("falls back to createdAt when updatedAt is missing", () => {
            const input = [
                entry("older", undefined, "2026-01-01T00:00:00Z"),
                entry("newer", undefined, "2026-05-01T00:00:00Z"),
            ];
            assert.deepEqual(
                sortSessionsDesc(input).map((s) => s.id),
                ["newer", "older"],
            );
        });

        it("breaks same-timestamp ties by id desc for a total ordering", () => {
            const same = "2026-04-01T00:00:00Z";
            const input = [entry("a", same), entry("c", same), entry("b", same)];
            assert.deepEqual(
                sortSessionsDesc(input).map((s) => s.id),
                ["c", "b", "a"],
            );
        });
    });

    describe("findCursorIndex", () => {
        const sorted = sortSessionsDesc([
            entry("a", "2026-03-01T00:00:00Z"),
            entry("b", "2026-02-01T00:00:00Z"),
            entry("c", "2026-01-01T00:00:00Z"),
        ]);

        it("starts at the head when no cursor is given", () => {
            assert.equal(findCursorIndex(sorted, undefined), 0);
        });

        it("resumes just past the cursor entry", () => {
            assert.equal(
                findCursorIndex(sorted, {
                    updatedAt: "2026-03-01T00:00:00Z",
                    id: asSessionId("a"),
                }),
                1,
            );
            assert.equal(
                findCursorIndex(sorted, {
                    updatedAt: "2026-02-01T00:00:00Z",
                    id: asSessionId("b"),
                }),
                2,
            );
        });

        it("returns the list length when the cursor is at or past the tail", () => {
            // Cursor on the last entry — nothing older remains.
            assert.equal(
                findCursorIndex(sorted, {
                    updatedAt: "2026-01-01T00:00:00Z",
                    id: asSessionId("c"),
                }),
                sorted.length,
            );
            // Cursor older than everything — also past the tail.
            assert.equal(
                findCursorIndex(sorted, {
                    updatedAt: "2020-01-01T00:00:00Z",
                    id: asSessionId("zzz"),
                }),
                sorted.length,
            );
        });

        it("handles an empty list", () => {
            assert.equal(
                findCursorIndex([], { updatedAt: "2026-01-01T00:00:00Z", id: asSessionId("a") }),
                0,
            );
        });

        it("resolves same-timestamp cursors by id so a tie cannot repeat a page", () => {
            const same = "2026-04-01T00:00:00Z";
            const tied = sortSessionsDesc([entry("a", same), entry("b", same), entry("c", same)]);
            // sorted desc by id => [c, b, a]; cursor at "b" must resume on "a".
            assert.equal(findCursorIndex(tied, { updatedAt: same, id: asSessionId("b") }), 2);
        });
    });

    describe("session.list pagination", () => {
        function makeCtx(count: number, params: Record<string, unknown>) {
            const fakeList = Array.from({ length: count }, (_, i) => ({
                id: `s${String(i).padStart(3, "0")}`,
                cwd: "/tmp/ws",
                path: `/tmp/ws/s${i}.jsonl`,
                // Descending createdAt so s000 is newest. No activityAt → list
                // falls back to createdAt for sort and relative time.
                createdAt: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString(),
                metadata: { kind: "main" },
            }));
            const workspace = {
                async listSessions() {
                    return fakeList;
                },
                async getSessionName() {
                    return undefined;
                },
                async getSessionFacts(id: string) {
                    const row = fakeList.find((r: { id: string }) => r.id === id);
                    return row?.metadata ?? {};
                },
                async getSessionActivityAt() {
                    return undefined;
                },
            };
            return {
                id: "test-id",
                workspace,
                cwd: "/tmp/ws",
                server: {},
                params,
            } as unknown as Parameters<
                NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]
            >[0];
        }

        async function callList(count: number, params: Record<string, unknown>) {
            const handler = getRegisteredMethod("session.list");
            assert.ok(handler);
            return (await handler.handler(makeCtx(count, params))) as {
                sessions: SessionListEntry[];
                nextCursor?: { updatedAt: string; id: string };
                total?: number;
            };
        }

        it("caps the first page at the default limit and reports the workspace total", async () => {
            const res = await callList(45, {});
            assert.equal(res.sessions.length, SESSION_LIST_DEFAULT_LIMIT);
            assert.equal(res.total, 45, "total is the workspace count, not the page size");
            assert.ok(res.nextCursor, "more sessions remain, so a cursor is returned");
        });

        it("omits nextCursor when everything fits on one page", async () => {
            const res = await callList(5, {});
            assert.equal(res.sessions.length, 5);
            assert.equal(res.total, 5);
            assert.equal(res.nextCursor, undefined);
        });

        it("walks pages via the cursor without repeating or skipping entries", async () => {
            const first = await callList(45, {});
            const second = await callList(45, { cursor: first.nextCursor });
            assert.equal(second.sessions.length, 15);
            assert.equal(second.total, 45);
            assert.equal(second.nextCursor, undefined, "tail page has no further cursor");

            const ids = [...first.sessions, ...second.sessions].map((s) => s.id);
            assert.equal(new Set(ids).size, 45, "pages together cover every session exactly once");
        });

        it("returns the whole list plus total when full is set", async () => {
            const res = await callList(45, { full: true });
            assert.equal(res.sessions.length, 45);
            assert.equal(res.total, 45);
            assert.equal(res.nextCursor, undefined);
        });

        it("honours an explicit limit larger than the default", async () => {
            const res = await callList(45, { limit: 40 });
            assert.equal(res.sessions.length, 40);
            assert.equal(res.total, 45);
            assert.ok(res.nextCursor);
        });
    });
});

describe("session.taskHistoryGet", () => {
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
});

describe("session.turnBusy", () => {
    /**
     * session.prompt / session.submitAnswers busy-path tests.
     *
     * Two ways a turn can be refused, both of which used to reach the client as an
     * unactionable `internal` error:
     *   - an in-flight compaction never settles → the handler must not call prompt()
     *     at all (pi would refuse the run from its compaction operation)
     *   - the lane is already running something → must be translated, since
     *     normalizeError only preserves the code of an RpcHandlerError
     *
     * The busy signal is pi 0.85's `LaneBusy`, a tagged error. It is deliberately
     * constructed here rather than faked with a message, because `LaneBusy` is NOT
     * a `HarnessFault` subclass — `instanceof HarnessFault` is false for it — and
     * an `instanceof`-based translation would silently stop detecting busy.
     *
     * Stub workspace / attached, same pattern as session.compactionHandlers.test.ts.
     */

    before(() => {
        registerBuiltinMethods();
    });

    type Handler = NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"];
    type Ctx = Parameters<Handler>[0];

    /**
     * Build a handler ctx whose compaction gate and prompt() are both scriptable.
     * `settled: false` models a compaction that outlives the wait.
     */
    function makeCtx(opts: {
        settled: boolean;
        prompt: () => Promise<unknown>;
        params?: Record<string, unknown>;
    }): { ctx: Ctx; promptCalls: () => number } {
        let promptCalls = 0;
        const attached = {
            session: { appendSessionName: async () => undefined },
            prompt: (...args: unknown[]) => {
                promptCalls++;
                void args;
                return opts.prompt();
            },
        };
        const workspace = {
            getAttached: () => attached,
            attach: async () => attached,
            invalidateListCache: () => undefined,
        };
        const ctx = {
            id: "test-id",
            workspace,
            cwd: "/tmp/ws",
            server: {
                awaitCompactionEnd: async () => opts.settled,
            },
            params: {
                workspace: "/tmp/ws",
                sessionId: "sid",
                text: "hello",
                ...opts.params,
            },
        } as unknown as Ctx;
        return { ctx, promptCalls: () => promptCalls };
    }

    function isSessionBusy(e: unknown): boolean {
        return e instanceof RpcHandlerError && e.code === "session_busy";
    }

    describe("session.prompt busy paths", () => {
        it("returns session_busy without prompting when compaction never settles", async () => {
            const { ctx, promptCalls } = makeCtx({
                settled: false,
                prompt: async () => ({ role: "assistant", content: "unreachable" }),
            });
            const method = getRegisteredMethod("session.prompt");
            assert.ok(method);

            await assert.rejects(method.handler(ctx), isSessionBusy);
            // Load-bearing: proceeding anyway is exactly the old bug — pi would be in
            // its `compaction` phase and throw a busy the client cannot classify.
            assert.equal(promptCalls(), 0, "must not start a turn while compacting");
        });

        it("translates pi's LaneBusy into session_busy", async () => {
            const { ctx } = makeCtx({
                settled: true,
                prompt: async () => {
                    throw new LaneBusy({
                        lane: "main",
                        operationId: "op-0",
                        operationKind: "run",
                        message: "lane is busy",
                    });
                },
            });
            const method = getRegisteredMethod("session.prompt");
            assert.ok(method);

            await assert.rejects(method.handler(ctx), isSessionBusy);
        });

        it("leaves non-busy harness errors alone", async () => {
            const authError = new Error("no credentials");
            const { ctx } = makeCtx({
                settled: true,
                prompt: async () => {
                    throw authError;
                },
            });
            const method = getRegisteredMethod("session.prompt");
            assert.ok(method);

            // Must NOT be laundered into session_busy — a client that retries an
            // auth failure loops forever.
            await assert.rejects(method.handler(ctx), (e: unknown) => e === authError);
        });

        it("proceeds normally once compaction has settled", async () => {
            const { ctx, promptCalls } = makeCtx({
                settled: true,
                prompt: async () => ({ role: "assistant", content: "ok" }),
            });
            const method = getRegisteredMethod("session.prompt");
            assert.ok(method);

            await method.handler(ctx);
            assert.equal(promptCalls(), 1);
        });
    });

    describe("session.submitAnswers busy paths", () => {
        it("returns session_busy without prompting when compaction never settles", async () => {
            const { ctx, promptCalls } = makeCtx({
                settled: false,
                prompt: async () => undefined,
                params: { toolCallId: "tc-1", answers: { q: "a" } },
            });
            const method = getRegisteredMethod("session.submitAnswers");
            assert.ok(method);

            await assert.rejects(method.handler(ctx), isSessionBusy);
            assert.equal(promptCalls(), 0);
        });
    });
});
