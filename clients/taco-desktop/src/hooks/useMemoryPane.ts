import { asWorkspaceId, type MemoryListResult } from "@taco-ai/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createJobsClient } from "../lib/clients/jobsClient.ts";
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
    /** Which dream action is in flight, so the pane can disable its controls. */
    dreamBusy: DreamBusy | null;
    handleDreamRun: () => Promise<void>;
    handleDreamApply: (previewId: string) => Promise<void>;
    handleDreamDiscard: () => Promise<void>;
    handleDreamUndo: (reportId: string) => Promise<void>;
    handleRestoreTopic: (id: string) => Promise<void>;
    handleDreamScheduleToggle: (enabled: boolean) => Promise<void>;
}

export type DreamBusy = "run" | "apply" | "discard" | "undo" | "restore" | "schedule";

/** Id of the daemon's built-in consolidation job (sidecar builtinJobs.ts). */
export const MEMORY_DREAM_JOB_ID = "memory-dream";

/** Loads memory topics + handles save/delete for the memory pane. */
export function useMemoryPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    t: (key: string) => string,
    /** Failure sink (the notification bell). Success is visible in the pane itself. */
    notify: (msg: string) => void,
): UseMemoryPaneResult {
    const [memoryData, setMemoryData] = useState<MemoryListResult | null>(null);
    const [memoryLoading, setMemoryLoading] = useState(false);
    const [memoryError, setMemoryError] = useState<string | null>(null);
    const [memorySelectedId, setMemorySelectedId] = useState<string>(MEMORY_ROOT_ID);
    const [memorySaving, setMemorySaving] = useState(false);
    const [dreamBusy, setDreamBusy] = useState<DreamBusy | null>(null);
    const jobs = useMemo(() => createJobsClient(client), [client]);

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
            .memoryList(asWorkspaceId(activeCwd))
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
                await client.memoryWrite(asWorkspaceId(activeCwd), content, baseHash);
                // No success toast: the editor closes on `ok` and the refreshed
                // content renders in its place.
                loadMemory();
                return { ok: true };
            } catch (e: unknown) {
                const err = e as { code?: string; data?: unknown };
                if (err?.code === "memory.conflict") {
                    const data = err.data as MemoryConflict;
                    return { ok: false, conflict: data };
                }
                console.error("[useMemoryPane] memory.write failed:", e);
                notify(t("memory.errorSave"));
                return { ok: false, conflict: { currentContent: "", currentHash: "" } };
            } finally {
                setMemorySaving(false);
            }
        },
        [activeCwd, client, loadMemory, notify, t],
    );

    const handleDeleteTopic = useCallback(
        async (id: string): Promise<void> => {
            if (!activeCwd) return;
            try {
                await client.memoryDeleteTopic(asWorkspaceId(activeCwd), id);
                // No success toast: the topic drops out of the refreshed list.
                loadMemory();
            } catch (e: unknown) {
                console.error("[useMemoryPane] memoryDeleteTopic failed:", e);
                notify(t("memory.errorDelete"));
            }
        },
        [activeCwd, client, loadMemory, notify, t],
    );

    /** Run one dream RPC: mark busy, refetch on success, notify on failure. */
    const runDreamAction = useCallback(
        async (
            busy: DreamBusy,
            action: (ws: ReturnType<typeof asWorkspaceId>) => Promise<unknown>,
        ) => {
            if (!activeCwd) return;
            setDreamBusy(busy);
            try {
                await action(asWorkspaceId(activeCwd));
                loadMemory();
            } catch (e: unknown) {
                console.error(`[useMemoryPane] dream ${busy} failed:`, e);
                notify(
                    `${t(`memory.dream.error.${busy}`)}${e instanceof Error && e.message ? `: ${e.message}` : ""}`,
                );
            } finally {
                setDreamBusy(null);
            }
        },
        [activeCwd, loadMemory, notify, t],
    );

    const handleDreamRun = useCallback(
        () =>
            runDreamAction("run", async (ws) => {
                const result = await client.memoryDreamRun(ws);
                if (result.status === "failed") {
                    notify(`${t("memory.dream.error.run")}: ${result.reason}`);
                } else if (result.status === "skipped") {
                    // A skip is not an error, but the user asked for a run: say why.
                    notify(`${t("memory.dream.nothingToDo")}: ${result.reason}`);
                }
            }),
        [client, notify, runDreamAction, t],
    );
    const handleDreamApply = useCallback(
        (previewId: string) =>
            runDreamAction("apply", (ws) => client.memoryDreamApply(ws, previewId)),
        [client, runDreamAction],
    );
    const handleDreamDiscard = useCallback(
        () => runDreamAction("discard", (ws) => client.memoryDreamDiscard(ws)),
        [client, runDreamAction],
    );
    const handleDreamUndo = useCallback(
        (reportId: string) =>
            runDreamAction("undo", async (ws) => {
                const { conflicts } = await client.memoryDreamUndo(ws, reportId);
                if (conflicts.length > 0) {
                    notify(`${t("memory.dream.undoConflicts")}: ${conflicts.join(", ")}`);
                }
            }),
        [client, notify, runDreamAction, t],
    );
    const handleRestoreTopic = useCallback(
        (id: string) => runDreamAction("restore", (ws) => client.memoryRestoreTopic(ws, id)),
        [client, runDreamAction],
    );
    // The switch edits the built-in job itself, so the Schedules tab and the
    // memory pane can never disagree about whether nightly dream is on.
    const handleDreamScheduleToggle = useCallback(
        (enabled: boolean) =>
            runDreamAction("schedule", async () => {
                const job = await jobs.get(MEMORY_DREAM_JOB_ID);
                if (!job) throw new Error("the consolidation job is not available");
                // Same rule as the Schedules tab: never send server-managed history.
                const { history: _history, ...rest } = job;
                await jobs.update({ ...rest, enabled });
            }),
        [jobs, runDreamAction],
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
        dreamBusy,
        handleDreamRun,
        handleDreamApply,
        handleDreamDiscard,
        handleDreamUndo,
        handleRestoreTopic,
        handleDreamScheduleToggle,
    };
}
