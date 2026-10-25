import { asWorkspaceId, type MemoryListResult } from "@taco-ai/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    /** Resolves true when the topic was deleted; failures are already notified. */
    handleDeleteTopic: (id: string) => Promise<boolean>;
    /** Which dream action is in flight, so the pane can disable its controls. */
    dreamBusy: DreamBusy | null;
    handleDreamRun: () => Promise<boolean>;
    handleDreamApply: (previewId: string) => Promise<boolean>;
    handleDreamDiscard: () => Promise<boolean>;
    handleDreamUndo: (reportId: string) => Promise<boolean>;
    /** Resolves true when the topic was restored; failures are already notified. */
    handleRestoreTopic: (id: string) => Promise<boolean>;
    handleDreamScheduleToggle: (enabled: boolean) => Promise<boolean>;
}

export type DreamBusy = "run" | "apply" | "discard" | "undo" | "restore" | "schedule";

/** Id of the daemon's built-in consolidation job (sidecar builtinJobs.ts). */
export const MEMORY_DREAM_JOB_ID = "memory-dream";

/**
 * Loads memory topics + handles save/delete/dream for the memory pane.
 *
 * Every result is checked against the workspace it was requested for. A
 * consolidation run takes tens of seconds; if the user switches workspace
 * meanwhile, its refetch must not show the old workspace's topics under the
 * new one, or a later delete would send the old ids against the new cwd.
 */
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
    // Busy is per workspace: a run still going in A must not lock B's buttons.
    const [dreamBusyFor, setDreamBusyFor] = useState<{ cwd: string; busy: DreamBusy } | null>(null);
    const jobs = useMemo(() => createJobsClient(client), [client]);

    // The workspace the pane shows now, read by async continuations.
    const cwdRef = useRef(activeCwd);
    cwdRef.current = activeCwd;
    // Only the newest list request may write state; an older one that
    // resolves later would overwrite fresher data.
    const listSeq = useRef(0);

    // Selection belongs to a workspace: reset it when the workspace changes,
    // not on every refetch (a refresh, apply or undo keeps the user in place).
    // Data from the previous workspace is dropped at the same time, so nothing
    // can act on it while the new list loads.
    // biome-ignore lint/correctness/useExhaustiveDependencies: activeCwd is the trigger, not an input
    useEffect(() => {
        setMemorySelectedId(MEMORY_ROOT_ID);
        setMemoryData(null);
        setMemoryError(null);
    }, [activeCwd]);

    const loadMemory = useCallback(() => {
        if (!activeCwd) return;
        const cwd = activeCwd;
        const seq = ++listSeq.current;
        setMemoryLoading(true);
        setMemoryError(null);
        void client
            .memoryList(asWorkspaceId(cwd))
            .then((r) => {
                if (seq !== listSeq.current || cwdRef.current !== cwd) return;
                setMemoryData(r);
            })
            .catch((e: unknown) => {
                if (seq !== listSeq.current || cwdRef.current !== cwd) return;
                console.error("[useMemoryPane] memoryList failed:", e);
                setMemoryError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                if (seq === listSeq.current) setMemoryLoading(false);
            });
    }, [activeCwd, client]);

    useEffect(() => {
        if (!active || !activeCwd) return;
        loadMemory();
    }, [active, activeCwd, loadMemory]);

    // A selection whose topic is gone after a refetch (deleted elsewhere,
    // merged by consolidation) falls back to the global entry.
    useEffect(() => {
        if (!memoryData || memorySelectedId === MEMORY_ROOT_ID) return;
        const live = memoryData.topics.some((topic) => topic.id === memorySelectedId);
        const archived = (memoryData.dream?.archived ?? []).some(
            (topic) => `archive:${topic.id}` === memorySelectedId,
        );
        if (!live && !archived) setMemorySelectedId(MEMORY_ROOT_ID);
    }, [memoryData, memorySelectedId]);

    /** Refetch only while the user is still on the workspace the action ran in. */
    const reloadIfCurrent = useCallback(
        (cwd: string) => {
            if (cwdRef.current === cwd) loadMemory();
        },
        [loadMemory],
    );

    const handleSaveMemory = useCallback(
        async (content: string, baseHash: string): Promise<SaveMemoryResult> => {
            if (!activeCwd) return { ok: false, conflict: { currentContent: "", currentHash: "" } };
            const cwd = activeCwd;
            setMemorySaving(true);
            try {
                await client.memoryWrite(asWorkspaceId(cwd), content, baseHash);
                // No success toast: the editor closes on `ok` and the refreshed
                // content renders in its place.
                reloadIfCurrent(cwd);
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
        [activeCwd, client, notify, reloadIfCurrent, t],
    );

    const handleDeleteTopic = useCallback(
        async (id: string): Promise<boolean> => {
            if (!activeCwd) return false;
            const cwd = activeCwd;
            // Compare-and-delete against what the pane showed: a topic the
            // extractor rewrote since is refused rather than deleted unseen.
            const shown = memoryData?.topics.find((topic) => topic.id === id)?.content;
            try {
                await client.memoryDeleteTopic(asWorkspaceId(cwd), id, shown);
                // No success toast: the topic drops out of the refreshed list.
                reloadIfCurrent(cwd);
                return true;
            } catch (e: unknown) {
                console.error("[useMemoryPane] memoryDeleteTopic failed:", e);
                notify(
                    `${t("memory.errorDelete")}${e instanceof Error && e.message ? `: ${e.message}` : ""}`,
                );
                reloadIfCurrent(cwd);
                return false;
            }
        },
        [activeCwd, client, memoryData, notify, reloadIfCurrent, t],
    );

    /** Run one dream RPC: mark busy, refetch on success, notify on failure. */
    const runDreamAction = useCallback(
        async (
            busy: DreamBusy,
            action: (ws: ReturnType<typeof asWorkspaceId>) => Promise<unknown>,
        ): Promise<boolean> => {
            if (!activeCwd) return false;
            const cwd = activeCwd;
            setDreamBusyFor({ cwd, busy });
            try {
                await action(asWorkspaceId(cwd));
                reloadIfCurrent(cwd);
                return true;
            } catch (e: unknown) {
                console.error(`[useMemoryPane] dream ${busy} failed:`, e);
                notify(
                    `${t(`memory.dream.error.${busy}`)}${e instanceof Error && e.message ? `: ${e.message}` : ""}`,
                );
                return false;
            } finally {
                setDreamBusyFor((current) => (current?.cwd === cwd ? null : current));
            }
        },
        [activeCwd, notify, reloadIfCurrent, t],
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

    const dreamBusy = dreamBusyFor && dreamBusyFor.cwd === activeCwd ? dreamBusyFor.busy : null;

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
