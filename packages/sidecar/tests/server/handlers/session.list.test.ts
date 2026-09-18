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

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";

import type { SessionListEntry } from "@taco-ai/protocol";
import {
    asSessionId,
    asWorkspaceId,
    SESSION_LIST_DEFAULT_LIMIT,
    SESSION_LIST_MAX_LIMIT,
} from "@taco-ai/protocol";
import {
    findCursorIndex,
    normalizeLimit,
    sortSessionsDesc,
} from "../../../src/server/handlers/sessionLifecycle.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

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
            findCursorIndex(sorted, { updatedAt: "2026-03-01T00:00:00Z", id: asSessionId("a") }),
            1,
        );
        assert.equal(
            findCursorIndex(sorted, { updatedAt: "2026-02-01T00:00:00Z", id: asSessionId("b") }),
            2,
        );
    });

    it("returns the list length when the cursor is at or past the tail", () => {
        // Cursor on the last entry — nothing older remains.
        assert.equal(
            findCursorIndex(sorted, { updatedAt: "2026-01-01T00:00:00Z", id: asSessionId("c") }),
            sorted.length,
        );
        // Cursor older than everything — also past the tail.
        assert.equal(
            findCursorIndex(sorted, { updatedAt: "2020-01-01T00:00:00Z", id: asSessionId("zzz") }),
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
