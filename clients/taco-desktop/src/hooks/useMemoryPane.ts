import type { MemoryListResult } from "@taco-ai/protocol";
import { useCallback, useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { MEMORY_ROOT_ID } from "../lib/memoryPaneTypes.js";

export interface MemoryConflict {
    currentContent: string;
    currentHash: string;
}

export type SaveMemoryResult = { ok: true } | { ok: false; conflict: MemoryConflict };

export interface UseMemoryPaneResult {
    memoryData: MemoryListResult | null;
    memoryLoading: boolean;
    memoryError: string | null;
    memorySelectedId: string;
    setMemorySelectedId: (id: string) => void;
    memorySaving: boolean;
    loadMemory: () => void;
    handleSaveMemory: (content: string, baseHash: string) => Promise<SaveMemoryResult>;
    handleDeleteTopic: (id: string) => Promise<void>;
}

/** Loads memory topics + handles save/delete for the memory pane. */
export function useMemoryPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    t: (key: string) => string,
    showToast: (msg: string) => void,
): UseMemoryPaneResult {
    const [memoryData, setMemoryData] = useState<MemoryListResult | null>(null);
    const [memoryLoading, setMemoryLoading] = useState(false);
    const [memoryError, setMemoryError] = useState<string | null>(null);
    const [memorySelectedId, setMemorySelectedId] = useState<string>(MEMORY_ROOT_ID);
    const [memorySaving, setMemorySaving] = useState(false);

    // Imperative refresh — only called after save / delete handlers succeed.
    // Not used by the active-gated useEffect below (that one calls the
    // callback inline). Exposed on the result solely so MemoryPane.onRefresh
    // can request a refetch (e.g. user clicks a refresh button), keeping the
    // RPC boundary inside the hook.
    const loadMemory = useCallback(() => {
        if (!activeCwd) return;
        setMemoryLoading(true);
        setMemoryError(null);
        void client
            .memoryList(activeCwd)
            .then((r) => {
                setMemoryData(r);
                // Fall back to global after data loads (prevents stale topic selection from previous cwd).
                setMemorySelectedId(MEMORY_ROOT_ID);
            })
            .catch((e: unknown) => {
                console.error("[useMemoryPane] memoryList failed:", e);
                setMemoryError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => setMemoryLoading(false));
    }, [activeCwd, client]);

    useEffect(() => {
        if (!active || !activeCwd) return;
        loadMemory();
    }, [active, activeCwd, loadMemory]);

    const handleSaveMemory = useCallback(
        async (content: string, baseHash: string): Promise<SaveMemoryResult> => {
            if (!activeCwd) return { ok: false, conflict: { currentContent: "", currentHash: "" } };
            setMemorySaving(true);
            try {
                await client.memoryWrite(activeCwd, content, baseHash);
                showToast(t("memory.savedToast"));
                loadMemory();
                return { ok: true };
            } catch (e: unknown) {
                const err = e as { code?: string; data?: unknown };
                if (err?.code === "memory.conflict") {
                    const data = err.data as MemoryConflict;
                    return { ok: false, conflict: data };
                }
                console.error("[useMemoryPane] memory.write failed:", e);
                showToast(t("memory.errorSave"));
                return { ok: false, conflict: { currentContent: "", currentHash: "" } };
            } finally {
                setMemorySaving(false);
            }
        },
        [activeCwd, client, loadMemory, showToast, t],
    );

    const handleDeleteTopic = useCallback(
        async (id: string): Promise<void> => {
            if (!activeCwd) return;
            try {
                await client.memoryDeleteTopic(activeCwd, id);
                showToast(t("memory.deletedToast"));
                loadMemory();
            } catch (e: unknown) {
                console.error("[useMemoryPane] memoryDeleteTopic failed:", e);
                showToast(t("memory.errorDelete"));
            }
        },
        [activeCwd, client, loadMemory, showToast, t],
    );

    return {
        memoryData,
        memoryLoading,
        memoryError,
        memorySelectedId,
        setMemorySelectedId,
        memorySaving,
        loadMemory,
        handleSaveMemory,
        handleDeleteTopic,
    };
}
