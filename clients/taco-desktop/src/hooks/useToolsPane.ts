import { asWorkspaceId, type ToolEntry } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface UseToolsPaneResult {
    tools: ToolEntry[];
    /** Non-null when the catalog fetch failed; clears itself after a few seconds. */
    error: string | null;
}

/** Loads the tool catalog when the tools pane becomes active. */
export function useToolsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseToolsPaneResult {
    const [tools, setTools] = useState<ToolEntry[]>([]);
    const { error, fail, clearError } = useAutoClearError();

    useEffect(() => {
        if (!active) return;
        setTools([]);
        if (!activeCwd) return;
        let cancelled = false;
        clearError();
        void client
            .toolsList({ workspace: asWorkspaceId(activeCwd) })
            .then((r) => {
                if (!cancelled) setTools(r.tools);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                console.error("[useToolsPane] toolsList failed:", e);
                fail(e);
            });
        return () => {
            cancelled = true;
        };
    }, [active, activeCwd, client, clearError, fail]);

    return { tools, error };
}
