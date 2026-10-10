/**
 * useCheckpointsPane — load restore points and drive a destructive restore.
 *
 * The list refreshes on every entry into the pane. A restore creates its own
 * pre-restore snapshot, so the user can undo an accidental click without
 * needing the UI to remember anything. Refreshing after restore surfaces that
 * new checkpoint at the top.
 */

import {
    asSessionId,
    asWorkspaceId,
    type CheckpointsListResult,
    type CheckpointsRestoreResult,
} from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";

export type RestoreResult = { ok: true; protectionId?: string } | { ok: false; reason: string };

export interface UseCheckpointsPaneResult {
    data: CheckpointsListResult | null;
    loading: boolean;
    error: string | null;
    restoringId: string | null;
    refresh: () => void;
    restore: (checkpointId: string) => Promise<RestoreResult>;
}

export function useCheckpointsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    activeSessionId: string | undefined,
    /** Failure sink (the notification bell). A clean restore is visible in the pane itself. */
    notify: (msg: string) => void,
): UseCheckpointsPaneResult {
    const [data, setData] = useState<CheckpointsListResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [restoringId, setRestoringId] = useState<string | null>(null);
    // Monotonic per-refresh token: stale responses from an earlier refresh
    // (e.g. user spam-clicking the button) are discarded so the latest click
    // always wins, regardless of network ordering.
    const refreshSeq = useRef(0);

    const refresh = useCallback(() => {
        if (!activeCwd) return;
        const seq = ++refreshSeq.current;
        setLoading(true);
        setError(null);
        void client
            .checkpointsList(
                asWorkspaceId(activeCwd),
                activeSessionId === undefined ? undefined : asSessionId(activeSessionId),
            )
            .then((result) => {
                if (seq !== refreshSeq.current) return;
                setData(result);
            })
            .catch((e: unknown) => {
                if (seq !== refreshSeq.current) return;
                console.error("[useCheckpointsPane] checkpointsList failed:", e);
                setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                if (seq !== refreshSeq.current) return;
                setLoading(false);
            });
    }, [activeCwd, activeSessionId, client]);

    useEffect(() => {
        if (!active || !activeCwd) return;
        refresh();
    }, [active, activeCwd, refresh]);

    const restore = useCallback(
        async (checkpointId: string): Promise<RestoreResult> => {
            if (!activeCwd) return { ok: false, reason: "no active workspace" };
            setRestoringId(checkpointId);
            try {
                const result: CheckpointsRestoreResult = await client.checkpointsRestore(
                    asWorkspaceId(activeCwd),
                    checkpointId,
                    activeSessionId === undefined ? undefined : asSessionId(activeSessionId),
                );
                if (result.failed.length > 0) {
                    // The pane does not list per-file failures, so name them
                    // here — a bare count would leave nothing to act on.
                    const paths = result.failed.map((f) => f.path);
                    const shown = paths.slice(0, 3).join(", ");
                    const more = paths.length > 3 ? ` (+${paths.length - 3})` : "";
                    notify(
                        `Restore incomplete: ${paths.length} file(s) not restored — ${shown}${more}`,
                    );
                }
                // No toast on a clean restore: the pane refreshes below, and the
                // protection checkpoint to undo with appears at the top of it.
                return { ok: true, protectionId: result.protectionId };
            } catch (e: unknown) {
                const reason = e instanceof Error ? e.message : String(e);
                notify(`Restore failed: ${reason}`);
                return { ok: false, reason };
            } finally {
                // Refresh on every path, including the throw. A rejected RPC
                // does not mean nothing changed: the sidecar may have written
                // some files, or taken the protection snapshot, before failing.
                // Leaving the pane on pre-restore data would misreport that.
                refresh();
                setRestoringId(null);
            }
        },
        [activeCwd, activeSessionId, client, refresh, notify],
    );

    return { data, loading, error, restoringId, refresh, restore };
}
