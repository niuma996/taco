import type { ToolEntry } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./useAutoClearError";

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
        if (!active || !activeCwd) return;
        clearError();
        void client
            .toolsList(activeCwd)
            .then((r) => setTools(r.tools))
            .catch((e: unknown) => {
                // Surface it: a swallowed failure renders an empty catalog that
                // is indistinguishable from a workspace with no tools.
                console.error("[useToolsPane] toolsList failed:", e);
                fail(e);
            });
    }, [active, activeCwd, client, clearError, fail]);

    return { tools, error };
}
