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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { queryError, refreshQueries, resourceQueryKey } from "../lib/queries/queryClient";

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
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: resourceQueryKey(client, "checkpoints", activeCwd),
        enabled: active && Boolean(activeCwd),
        retry: false,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.checkpointsList({ workspace: asWorkspaceId(activeCwd as string) });
        },
    });
    const [restoring, setRestoring] = useState<{
        client: TacoClient;
        cwd: string;
        checkpointId: string;
    } | null>(null);

    const refresh = useCallback(() => {
        if (active && activeCwd)
            void refreshQueries(queryClient, {
                queryKey: resourceQueryKey(client, "checkpoints", activeCwd),
            });
    }, [active, activeCwd, client, queryClient]);

    const restore = useCallback(
        async (checkpointId: string): Promise<RestoreResult> => {
            if (!activeCwd) return { ok: false, reason: "no active workspace" };
            const operation = { client, cwd: activeCwd, checkpointId };
            setRestoring(operation);
            try {
                const result: CheckpointsRestoreResult = await client.checkpointsRestore({
                    workspace: asWorkspaceId(activeCwd),
                    checkpointId,
                    sessionId:
                        activeSessionId === undefined ? undefined : asSessionId(activeSessionId),
                });
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
                if (result.conflicts.length > 0) {
                    const paths = result.conflicts.map((conflict) => conflict.path);
                    notify(
                        `Restore skipped ${paths.length} changed file(s): ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` (+${paths.length - 3})` : ""}`,
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
                void refreshQueries(queryClient, {
                    queryKey: resourceQueryKey(client, "checkpoints", operation.cwd),
                });
                setRestoring((current) => (current === operation ? null : current));
            }
        },
        [activeCwd, activeSessionId, client, queryClient, notify],
    );

    return {
        data: query.data ?? null,
        loading: query.isFetching,
        error: queryError(query.error)?.message ?? null,
        restoringId:
            restoring?.client === client && restoring.cwd === activeCwd
                ? restoring.checkpointId
                : null,
        refresh,
        restore,
    };
}
