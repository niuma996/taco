/**
 * useSessionSearch — server-side session search for the sidebar.
 *
 * The sidebar list is paginated: the server hands out one page at a time
 * (30 of 128 rows in a busy workspace), so filtering the rows the client
 * already holds would only ever match that first page. The query therefore
 * goes to the server, which filters the whole workspace before slicing — and
 * the cursor it returns pages through the matches, not through the
 * workspace's whole list.
 *
 * Typing is debounced: a request per keystroke would re-scan the workspace
 * store for every character.
 */

import { asSessionId, asWorkspaceId, type SessionListResult } from "@taco-ai/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionMeta } from "../lib/chat/workspaceReducer.ts";
import type { TacoClient } from "../lib/clients/tacoClient.ts";

/** Keystrokes within this window collapse into one request. */
export const SESSION_SEARCH_DEBOUNCE_MS = 200;

/** One page of matches plus the cursor that continues it. */
interface SearchResults {
    /** The workspace these results belong to. Results from another workspace
     *  are never shown: attaching them would open the session under the wrong
     *  cwd. */
    cwd?: string;
    /** The query these results belong to. A cursor may only be used with
     *  the query it was issued for. */
    query: string;
    sessions: SessionMeta[];
    cursor?: { updatedAt: string; id: string };
    /** Total matches in the workspace, not just the loaded ones. */
    total?: number;
    /** The request failed; the empty list is not "no matches". */
    failed?: boolean;
}

const NO_RESULTS: SearchResults = { query: "", sessions: [] };

export interface UseSessionSearchResult {
    /** The raw text in the search box. */
    query: string;
    setQuery: (q: string) => void;
    /** True while the typed query has not reached the server yet. */
    pending: boolean;
    /** Matches for the debounced query, newest first. */
    sessions: SessionMeta[];
    /** Cursor for the next page of matches; undefined = all matches loaded. */
    cursor?: { updatedAt: string; id: string };
    /** Total number of matches in the workspace. */
    total?: number;
    /** The last request failed; the empty list is not "no matches". */
    failed: boolean;
    /** A request is in flight. */
    loading: boolean;
    /** Fetch the next page of matches. */
    loadMore: () => void;
    /** Re-run the current query, e.g. after a rename or delete. */
    refresh: () => void;
}
function toSessionMeta(s: NonNullable<SessionListResult["sessions"]>[number]): SessionMeta {
    return {
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        filePath: s.filePath,
        name: s.name,
        messageCount: s.messageCount,
    };
}

export function useSessionSearch(
    client: TacoClient,
    cwd: string | undefined,
): UseSessionSearchResult {
    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [results, setResults] = useState<SearchResults>(NO_RESULTS);
    const [loading, setLoading] = useState(false);

    // The workspace the results belong to, read by async continuations.
    const cwdRef = useRef(cwd);
    cwdRef.current = cwd;
    // Only the newest request may write state; an older one resolving later
    // would overwrite fresher results.
    const seqRef = useRef(0);

    // The typed query has not reached the server yet.
    const pending = query.trim() !== debounced;

    // Debounce the query. Clearing the box applies immediately — there is
    // nothing to look up, and the sidebar should go back to the normal list
    // without waiting out the timer.
    useEffect(() => {
        const trimmed = query.trim();
        if (trimmed === "") {
            setDebounced("");
            return;
        }
        const timer = setTimeout(() => setDebounced(trimmed), SESSION_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);

    /** Fetch the first page of a query. Shared by the debounce effect and
     *  refresh(), which re-runs the current query after a rename or delete. */
    const fetchFirstPage = useCallback(
        (target: string, q: string) => {
            const seq = ++seqRef.current;
            setLoading(true);
            void client
                .sessionList({ workspace: asWorkspaceId(target), query: q })
                .then((r) => {
                    if (seq !== seqRef.current || cwdRef.current !== target) return;
                    setResults({
                        cwd: target,
                        query: q,
                        sessions: (r.sessions ?? []).map(toSessionMeta),
                        cursor: r.nextCursor
                            ? { updatedAt: r.nextCursor.updatedAt, id: r.nextCursor.id }
                            : undefined,
                        total: r.total,
                    });
                })
                .catch((err: unknown) => {
                    if (seq !== seqRef.current || cwdRef.current !== target) return;
                    console.error("[useSessionSearch] session.list failed:", err);
                    setResults({ cwd: target, query: q, sessions: [], failed: true });
                })
                .finally(() => {
                    if (seq === seqRef.current) setLoading(false);
                });
        },
        [client],
    );

    // Fetch the first page of matches. Also the reset path: an empty query
    // clears the results so the sidebar falls back to the normal list.
    useEffect(() => {
        if (!cwd || debounced === "") {
            // Invalidate anything in flight — its response must not resurrect
            // the query the user just cleared.
            seqRef.current++;
            setResults(NO_RESULTS);
            setLoading(false);
            return;
        }
        fetchFirstPage(cwd, debounced);
    }, [cwd, debounced, fetchFirstPage]);

    /** Re-run the current query with the same text (the matches changed). */
    const refresh = useCallback(() => {
        if (!cwd || debounced === "") return;
        fetchFirstPage(cwd, debounced);
    }, [cwd, debounced, fetchFirstPage]);

    /** Continue the result set — the cursor belongs to the matches, so it
     *  pages within them rather than through the whole workspace. */
    const loadMore = useCallback(() => {
        // The cursor is only valid for the query (and workspace) it was
        // issued for. A query the user has already typed but not yet sent
        // counts as newer: the results on screen are about to be replaced, so
        // paging them now would ask the server for a page of a query the user
        // moved on from.
        if (
            !cwd ||
            results.cwd !== cwd ||
            !results.cursor ||
            results.query !== debounced ||
            pending ||
            loading
        )
            return;
        const seq = ++seqRef.current;
        const target = cwd;
        setLoading(true);
        void client
            .sessionList({
                workspace: asWorkspaceId(target),
                query: results.query,
                cursor: results.cursor
                    ? {
                          updatedAt: results.cursor.updatedAt,
                          id: asSessionId(results.cursor.id),
                      }
                    : undefined,
            })
            .then((r) => {
                if (seq !== seqRef.current || cwdRef.current !== target) return;
                setResults((prev) => ({
                    cwd: target,
                    query: prev.query,
                    sessions: [...prev.sessions, ...(r.sessions ?? []).map(toSessionMeta)],
                    cursor: r.nextCursor
                        ? { updatedAt: r.nextCursor.updatedAt, id: r.nextCursor.id }
                        : undefined,
                    total: r.total,
                }));
            })
            .catch((err: unknown) => {
                console.error("[useSessionSearch] session.list (load more) failed:", err);
            })
            .finally(() => {
                if (seq === seqRef.current) setLoading(false);
            });
    }, [client, cwd, debounced, loading, pending, results.cursor, results.query, results.cwd]);

    // Results tagged with another workspace were fetched for it, so they are
    // withheld until this workspace's own request lands — a fresh mount reads
    // them synchronously during the render that changes `cwd`.
    const shown = results.cwd === cwd ? results : NO_RESULTS;

    return {
        query,
        setQuery,
        pending,
        sessions: shown.sessions,
        cursor: shown.cursor,
        total: shown.total,
        failed: shown.failed ?? false,
        loading,
        loadMore,
        refresh,
    };
}

interface WorkspaceSearchEntry {
    query: string;
    debounced: string;
    results: SearchResults;
    loading: boolean;
}

function emptyWorkspaceSearchEntry(): WorkspaceSearchEntry {
    return { query: "", debounced: "", results: NO_RESULTS, loading: false };
}

/** Per-workspace search controllers. The navigation column can keep several
 *  workspaces open without letting one workspace's query or cursor leak into
 *  another. */
export interface UseSessionSearchesResult {
    forWorkspace: (cwd: string) => UseSessionSearchResult;
}

export function useSessionSearches(client: TacoClient): UseSessionSearchesResult {
    const [entries, setEntries] = useState<Record<string, WorkspaceSearchEntry>>({});
    const entriesRef = useRef(entries);
    entriesRef.current = entries;
    const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const seqRef = useRef(new Map<string, number>());

    useEffect(
        () => () => {
            for (const timer of timersRef.current.values()) clearTimeout(timer);
            timersRef.current.clear();
        },
        [],
    );

    const updateEntry = useCallback(
        (cwd: string, update: (entry: WorkspaceSearchEntry) => WorkspaceSearchEntry): void => {
            setEntries((current) => {
                const entry = current[cwd] ?? emptyWorkspaceSearchEntry();
                const nextEntry = update(entry);
                if (nextEntry === entry) return current;
                const next = { ...current, [cwd]: nextEntry };
                entriesRef.current = next;
                return next;
            });
        },
        [],
    );

    const nextSequence = useCallback((cwd: string): number => {
        const next = (seqRef.current.get(cwd) ?? 0) + 1;
        seqRef.current.set(cwd, next);
        return next;
    }, []);

    const fetchFirstPage = useCallback(
        (target: string, query: string): void => {
            const seq = nextSequence(target);
            updateEntry(target, (entry) => ({ ...entry, loading: true }));
            void client
                .sessionList({ workspace: asWorkspaceId(target), query })
                .then((result) => {
                    if (seqRef.current.get(target) !== seq) return;
                    updateEntry(target, (entry) => ({
                        ...entry,
                        results: {
                            cwd: target,
                            query,
                            sessions: (result.sessions ?? []).map(toSessionMeta),
                            cursor: result.nextCursor
                                ? {
                                      updatedAt: result.nextCursor.updatedAt,
                                      id: result.nextCursor.id,
                                  }
                                : undefined,
                            total: result.total,
                        },
                    }));
                })
                .catch((err: unknown) => {
                    if (seqRef.current.get(target) !== seq) return;
                    console.error("[useSessionSearches] session.list failed:", err);
                    updateEntry(target, (entry) => ({
                        ...entry,
                        results: { cwd: target, query, sessions: [], failed: true },
                    }));
                })
                .finally(() => {
                    if (seqRef.current.get(target) === seq)
                        updateEntry(target, (entry) => ({ ...entry, loading: false }));
                });
        },
        [client, nextSequence, updateEntry],
    );

    const setQuery = useCallback(
        (cwd: string, query: string): void => {
            const existingTimer = timersRef.current.get(cwd);
            if (existingTimer) clearTimeout(existingTimer);
            timersRef.current.delete(cwd);

            const trimmed = query.trim();
            if (trimmed === "") {
                nextSequence(cwd);
                updateEntry(cwd, (entry) => ({
                    ...entry,
                    query,
                    debounced: "",
                    results: NO_RESULTS,
                    loading: false,
                }));
                return;
            }

            updateEntry(cwd, (entry) => ({ ...entry, query }));
            timersRef.current.set(
                cwd,
                setTimeout(() => {
                    timersRef.current.delete(cwd);
                    if (entriesRef.current[cwd]?.query.trim() !== trimmed) return;
                    updateEntry(cwd, (entry) => ({ ...entry, debounced: trimmed }));
                    fetchFirstPage(cwd, trimmed);
                }, SESSION_SEARCH_DEBOUNCE_MS),
            );
        },
        [fetchFirstPage, nextSequence, updateEntry],
    );

    const refresh = useCallback(
        (cwd: string): void => {
            const debounced = entriesRef.current[cwd]?.debounced ?? "";
            if (debounced !== "") fetchFirstPage(cwd, debounced);
        },
        [fetchFirstPage],
    );

    const loadMore = useCallback(
        (cwd: string): void => {
            const entry = entriesRef.current[cwd];
            if (
                !entry ||
                entry.results.cwd !== cwd ||
                !entry.results.cursor ||
                entry.results.query !== entry.debounced ||
                entry.query.trim() !== entry.debounced ||
                entry.loading
            )
                return;
            const seq = nextSequence(cwd);
            const cursor = entry.results.cursor;
            updateEntry(cwd, (current) => ({ ...current, loading: true }));
            void client
                .sessionList({
                    workspace: asWorkspaceId(cwd),
                    query: entry.results.query,
                    cursor: {
                        updatedAt: cursor.updatedAt,
                        id: asSessionId(cursor.id),
                    },
                })
                .then((result) => {
                    if (seqRef.current.get(cwd) !== seq) return;
                    updateEntry(cwd, (current) => ({
                        ...current,
                        results: {
                            cwd,
                            query: current.results.query,
                            sessions: [
                                ...current.results.sessions,
                                ...(result.sessions ?? []).map(toSessionMeta),
                            ],
                            cursor: result.nextCursor
                                ? {
                                      updatedAt: result.nextCursor.updatedAt,
                                      id: result.nextCursor.id,
                                  }
                                : undefined,
                            total: result.total,
                        },
                    }));
                })
                .catch((err: unknown) => {
                    console.error("[useSessionSearches] session.list (load more) failed:", err);
                })
                .finally(() => {
                    if (seqRef.current.get(cwd) === seq)
                        updateEntry(cwd, (current) => ({ ...current, loading: false }));
                });
        },
        [client, nextSequence, updateEntry],
    );

    const forWorkspace = useCallback(
        (cwd: string): UseSessionSearchResult => {
            const entry = entries[cwd] ?? emptyWorkspaceSearchEntry();
            const shown = entry.results.cwd === cwd ? entry.results : NO_RESULTS;
            return {
                query: entry.query,
                setQuery: (query) => setQuery(cwd, query),
                pending: entry.query.trim() !== entry.debounced,
                sessions: shown.sessions,
                cursor: shown.cursor,
                total: shown.total,
                failed: shown.failed ?? false,
                loading: entry.loading,
                loadMore: () => loadMore(cwd),
                refresh: () => refresh(cwd),
            };
        },
        [entries, loadMore, refresh, setQuery],
    );

    return useMemo(() => ({ forWorkspace }), [forWorkspace]);
}
