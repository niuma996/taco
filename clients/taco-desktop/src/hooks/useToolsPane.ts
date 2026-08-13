import type { ToolEntry } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";

export interface UseToolsPaneResult {
    tools: ToolEntry[];
}

/** Loads the tool catalog when the tools pane becomes active. */
export function useToolsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseToolsPaneResult {
    const [tools, setTools] = useState<ToolEntry[]>([]);

    useEffect(() => {
        if (!active || !activeCwd) return;
        void client
            .toolsList(activeCwd)
            .then((r) => setTools(r.tools))
            .catch((e) => {
                console.error("[useToolsPane] toolsList failed:", e);
            });
    }, [active, activeCwd, client]);

    return { tools };
}
