import type { AgentEntry } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";
import { useAutoClearError } from "./useAutoClearError";

export interface UseAgentsPaneResult {
    agents: AgentEntry[];
    /** Non-null when the agents list fetch failed; clears itself after a few seconds. */
    agentsError: string | null;
    selectedAgentType: string | null;
    setSelectedAgentType: (type: string | null) => void;
    agentContent: string;
    agentContentLoading: boolean;
    agentContentError: string | null;
}

/** Loads the agents list + selected agent system prompt when the agents pane is active. */
export function useAgentsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseAgentsPaneResult {
    const [agents, setAgents] = useState<AgentEntry[]>([]);
    const {
        error: agentsError,
        fail: failAgentsList,
        clearError: clearAgentsError,
    } = useAutoClearError();
    const [selectedAgentType, setSelectedAgentType] = useState<string | null>(null);
    const [agentContent, setAgentContent] = useState<string>("");
    const [agentContentLoading, setAgentContentLoading] = useState(false);
    const [agentContentError, setAgentContentError] = useState<string | null>(null);

    // Load list + auto-select first item so the content effect fires on entry.
    useEffect(() => {
        if (!active || !activeCwd) return;
        // reset selection + content so previous workspace's state doesn't leak through
        setSelectedAgentType(null);
        setAgentContent("");
        setAgentContentError(null);
        clearAgentsError();
        void client
            .agentsList(activeCwd)
            .then((r) => {
                setAgents(r.agents);
                if (r.agents.length > 0) {
                    setSelectedAgentType(r.agents[0].agentType);
                }
            })
            .catch((e: unknown) => {
                // Surface it: a swallowed failure renders an empty list that is
                // indistinguishable from a workspace with no agents.
                console.error("[useAgentsPane] agentsList failed:", e);
                failAgentsList(e);
            });
    }, [active, activeCwd, client, clearAgentsError, failAgentsList]);

    // Fetch agent system prompt when user picks an agent.
    // Cancellation flag prevents slow earlier requests from overwriting later selections.
    useEffect(() => {
        let cancelled = false;
        setAgentContent("");
        setAgentContentError(null);
        if (!selectedAgentType || !activeCwd) return;
        setAgentContentLoading(true);
        void client
            .agentsContent(activeCwd, selectedAgentType)
            .then((r) => {
                if (cancelled) return;
                setAgentContent(r.systemPrompt);
                setAgentContentError(null);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setAgentContentError(e instanceof Error ? e.message : String(e));
                setAgentContent("");
            })
            .finally(() => {
                if (!cancelled) setAgentContentLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedAgentType, activeCwd, client]);

    return {
        agents,
        agentsError,
        selectedAgentType,
        setSelectedAgentType,
        agentContent,
        agentContentLoading,
        agentContentError,
    };
}
