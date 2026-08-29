/**
 * useFileTree — 目录树状态机:entriesByDir cache + expanded 渲染标志 + 错误状态。
 *
 * 不变式:
 *  - entriesByDir 是 cache,expanded 是 render 标志,两者不强同步(折叠再展开不重 IO)
 *  - 任何 readDir 失败 → 整棵树 error,不 attempt 逐目录恢复
 *  - refresh() 清 cache + expanded + loadRoot()
 */
import { useCallback, useRef, useState } from "react";

import {
    type DirectoryListing,
    type FileEntry,
    filterEntries,
    sortEntries,
} from "../lib/fileTypes";
import type { FsClient } from "../lib/clients/fsClient";

export interface UseFileTreeApi {
    entriesByDir: DirectoryListing;
    expanded: ReadonlySet<string>;
    error: string | null;
    showHidden: boolean;
    setShowHidden(v: boolean): Promise<void>;
    loadRoot(): Promise<void>;
    toggleExpand(relPath: string): Promise<void>;
    refresh(): Promise<void>;
}

export function useFileTree(api: FsClient): UseFileTreeApi {
    const [entriesByDir, setEntriesByDir] = useState<DirectoryListing>(new Map());
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [showHidden, setShowHiddenState] = useState(false);
    // Read current showHidden synchronously inside async callbacks to avoid stale closures.
    const showHiddenRef = useRef(false);

    const fetchDir = useCallback(
        async (rel: string) => {
            try {
                const raw: FileEntry[] = await api.readDir(rel);
                const filtered = sortEntries(
                    filterEntries(raw, { showHidden: showHiddenRef.current }),
                );
                setEntriesByDir((prev) => {
                    const next = new Map(prev);
                    next.set(rel, filtered);
                    return next;
                });
                setError(null);
            } catch (e) {
                setError((e as Error).message);
            }
        },
        [api],
    );

    const loadRoot = useCallback(async () => {
        await fetchDir("");
    }, [fetchDir]);

    const toggleExpand = useCallback(
        async (rel: string) => {
            if (expanded.has(rel)) {
                setExpanded((prev) => {
                    const next = new Set(prev);
                    next.delete(rel);
                    return next;
                });
                return;
            }
            // expand
            setExpanded((prev) => new Set(prev).add(rel));
            if (!entriesByDir.has(rel)) {
                await fetchDir(rel);
            }
        },
        [expanded, entriesByDir, fetchDir],
    );

    const refresh = useCallback(async () => {
        setEntriesByDir(new Map());
        setExpanded(new Set());
        await fetchDir("");
    }, [fetchDir]);

    const setShowHidden = useCallback(
        async (v: boolean) => {
            showHiddenRef.current = v;
            setShowHiddenState(v);
            // Cached results for expanded dirs may reflect old filter; clear and reload root + expanded dirs with new flag (keep expanded).
            const dirsToReload = ["", ...Array.from(expanded)];
            setEntriesByDir(new Map());
            await Promise.all(dirsToReload.map((rel) => fetchDir(rel)));
        },
        [fetchDir, expanded],
    );

    return {
        entriesByDir,
        expanded,
        error,
        showHidden,
        setShowHidden,
        loadRoot,
        toggleExpand,
        refresh,
    };
}
