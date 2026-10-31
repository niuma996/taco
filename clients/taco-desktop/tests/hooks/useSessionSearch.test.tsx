import { strict as assert } from "node:assert";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { SESSION_SEARCH_DEBOUNCE_MS, useSessionSearch } from "../../src/hooks/useSessionSearch";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";

interface SessionRow {
    id: string;
    name?: string;
}

/** Minimal `session.list` stand-in: records the params it was called with and
 *  answers with the page the cursor asks for. */
function fakeClient(pages: SessionRow[][]) {
    const calls: Array<{ query?: string; cursor?: { id: string } }> = [];
    const sessionList = vi.fn(async (params: { query?: string; cursor?: { id: string } }) => {
        calls.push(params);
        const rows = params.cursor ? (pages[1] ?? []) : (pages[0] ?? []);
        return {
            workspace: "/ws",
            sessions: rows.map((r) => ({
                id: r.id,
                cwd: "/ws",
                filePath: `/ws/${r.id}.jsonl`,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                name: r.name,
            })),
            nextCursor: params.cursor
                ? undefined
                : pages[1]
                  ? { updatedAt: "2026-01-01T00:00:00Z", id: "cursor-1" as never }
                  : undefined,
            total: rows.length,
        };
    });
    return { client: { sessionList } as unknown as TacoClient, sessionList, calls };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("useSessionSearch", () => {
    it("debounces the query before asking the server", async () => {
        const { client, sessionList } = fakeClient([[]]);
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("深"));
        assert.equal(sessionList.mock.calls.length, 0, "no request while typing");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });
        assert.equal(sessionList.mock.calls.length, 1, "one request after the debounce");
        assert.equal(sessionList.mock.calls[0]?.[0]?.query, "深");
    });

    it("collapses a burst of keystrokes into a single request", async () => {
        const { client, sessionList } = fakeClient([[]]);
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("d"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
        act(() => result.current.setQuery("de"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
        act(() => result.current.setQuery("deep"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });

        assert.equal(sessionList.mock.calls.length, 1);
        assert.equal(sessionList.mock.calls[0]?.[0]?.query, "deep");
    });

    it("exposes the server's matches and pages through them", async () => {
        const { client, sessionList } = fakeClient([
            [{ id: "a", name: "Alpha" }],
            [{ id: "b", name: "Beta" }],
        ]);
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("a"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });

        assert.deepEqual(
            result.current.sessions.map((s) => s.id),
            ["a"],
        );
        assert.ok(result.current.cursor, "a cursor is offered while matches remain");

        await act(async () => {
            result.current.loadMore();
        });

        assert.equal(sessionList.mock.calls.length, 2);
        // The second page continues the result set — same query, the cursor.
        assert.equal(sessionList.mock.calls[1]?.[0]?.query, "a");
        assert.equal(sessionList.mock.calls[1]?.[0]?.cursor?.id, "cursor-1");
        assert.deepEqual(
            result.current.sessions.map((s) => s.id),
            ["a", "b"],
        );
        assert.equal(result.current.cursor, undefined, "no cursor once every match is loaded");
    });

    it("clearing the query drops the matches without a request", async () => {
        const { client, sessionList } = fakeClient([[{ id: "a", name: "Alpha" }]]);
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("a"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });
        assert.equal(result.current.sessions.length, 1);

        act(() => result.current.setQuery(""));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });

        assert.equal(result.current.sessions.length, 0);
        assert.equal(sessionList.mock.calls.length, 1, "clearing asks for nothing");
    });

    it("does not page a stale cursor after the query changed", async () => {
        const { client, sessionList } = fakeClient([
            [{ id: "a", name: "Alpha" }],
            [{ id: "b", name: "Beta" }],
        ]);
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("a"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });
        act(() => result.current.setQuery("b"));
        // The cursor still belongs to "a"; the results on screen are about to
        // be replaced, so paging them now would be a page of a stale query.
        await act(async () => {
            result.current.loadMore();
        });
        assert.equal(sessionList.mock.calls.length, 1, "the stale cursor was not used");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });
        assert.equal(sessionList.mock.calls.length, 2);
        assert.equal(sessionList.mock.calls[1]?.[0]?.query, "b");
    });

    it("withholds the previous workspace's matches when the workspace changes", async () => {
        const sessionList = vi.fn(async (params: { workspace: string }) => ({
            workspace: params.workspace,
            sessions: [
                {
                    id: params.workspace === "/ws" ? "a" : "b",
                    cwd: params.workspace,
                    filePath: "/tmp/ws/s.jsonl",
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                },
            ],
            total: 1,
        }));
        const client = { sessionList } as unknown as TacoClient;
        const { result, rerender } = renderHook(
            ({ cwd }: { cwd: string }) => useSessionSearch(client, cwd),
            { initialProps: { cwd: "/ws" } },
        );

        act(() => result.current.setQuery("x"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });
        assert.deepEqual(
            result.current.sessions.map((s) => s.id),
            ["a"],
        );

        // The old matches must be hidden in the very render that changes cwd,
        // not only once the new request resolves — otherwise a click would
        // attach a previous workspace's session under the new cwd.
        act(() => rerender({ cwd: "/ws2" }));
        assert.equal(result.current.sessions.length, 0, "the old workspace's matches are hidden");

        await act(async () => {});
        assert.deepEqual(
            result.current.sessions.map((s) => s.id),
            ["b"],
        );
    });

    it("re-runs the current query when refresh is called", async () => {
        const { client, sessionList } = fakeClient([[{ id: "a", name: "Alpha" }]]);
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("a"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });
        assert.equal(sessionList.mock.calls.length, 1);

        act(() => result.current.refresh());
        await act(async () => {});

        assert.equal(sessionList.mock.calls.length, 2, "refresh re-runs the query");
        assert.equal(sessionList.mock.calls[1]?.[0]?.query, "a");
    });

    it("drops a response that lands after the query was cleared", async () => {
        let resolveList: ((value: unknown) => void) | undefined;
        const sessionList = vi.fn(
            () =>
                new Promise((resolve) => {
                    resolveList = resolve;
                }),
        );
        const client = { sessionList } as unknown as TacoClient;
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("a"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });
        assert.equal(sessionList.mock.calls.length, 1, "the request is in flight");

        act(() => result.current.setQuery(""));
        await act(async () => {});
        assert.equal(result.current.sessions.length, 0);

        await act(async () => {
            resolveList?.({
                workspace: "/ws",
                sessions: [
                    {
                        id: "a",
                        cwd: "/ws",
                        filePath: "/tmp/ws/a.jsonl",
                        createdAt: "2026-01-01T00:00:00Z",
                        updatedAt: "2026-01-01T00:00:00Z",
                    },
                ],
                total: 1,
            });
        });

        assert.equal(result.current.sessions.length, 0, "the late response was discarded");
    });

    it("marks a failed request as failed rather than as no matches", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const sessionList = vi.fn(async () => {
            throw new Error("boom");
        });
        const client = { sessionList } as unknown as TacoClient;
        const { result } = renderHook(() => useSessionSearch(client, "/ws"));

        act(() => result.current.setQuery("a"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SESSION_SEARCH_DEBOUNCE_MS);
        });

        assert.equal(result.current.failed, true);
        assert.equal(result.current.sessions.length, 0);
        consoleError.mockRestore();
    });
});
