import { type AgentEntry, type AgentsContentResult, asWorkspaceId } from "@taco-ai/protocol";
import { useCallback, useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface AgentSaveInput {
    agentType: string;
    description: string;
    whenToUse?: string;
    maxTurns: number;
    systemPrompt: string;
}

export interface UseAgentsPaneResult {
    agents: AgentEntry[];
    /** Non-null when the agents list fetch failed; clears itself after a few seconds. */
    agentsError: string | null;
    selectedAgentType: string | null;
    setSelectedAgentType: (type: string | null) => void;
    agentContent: AgentsContentResult | null;
    agentContentLoading: boolean;
    agentContentError: string | null;
    /** True while an agents.write/delete RPC is in flight. */
    agentSaving: boolean;
    saveAgent: (input: AgentSaveInput, previousAgentType?: string) => Promise<void>;
    deleteAgent: (agentType: string) => Promise<void>;
}

/** Loads the agents list + selected agent content, and owns write/delete mutations. */
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
    const [agentContent, setAgentContent] = useState<AgentsContentResult | null>(null);
    const [agentContentLoading, setAgentContentLoading] = useState(false);
    const [agentContentError, setAgentContentError] = useState<string | null>(null);
    const [agentSaving, setAgentSaving] = useState(false);

    const reload = useCallback(async () => {
        if (!activeCwd) return;
        const r = await client.agentsList(asWorkspaceId(activeCwd));
        setAgents(r.agents);
        setSelectedAgentType((prev) =>
            prev !== null && r.agents.some((a) => a.agentType === prev)
                ? prev
                : (r.agents[0]?.agentType ?? null),
        );
    }, [activeCwd, client]);

    // Load list on entry so the content effect fires on the first item.
    useEffect(() => {
        if (!active || !activeCwd) return;
        setSelectedAgentType(null);
        setAgentContent(null);
        setAgentContentError(null);
        clearAgentsError();
        reload().catch((e: unknown) => {
            // Surface it: a swallowed failure renders an empty list that is
            // indistinguishable from a workspace with no agents.
            console.error("[useAgentsPane] agentsList failed:", e);
            failAgentsList(e);
        });
    }, [active, activeCwd, reload, clearAgentsError, failAgentsList]);

    // Fetch agent content when user picks an agent.
    // Cancellation flag prevents slow earlier requests from overwriting later selections.
    useEffect(() => {
        let cancelled = false;
        setAgentContent(null);
        setAgentContentError(null);
        if (!selectedAgentType || !activeCwd) return;
        setAgentContentLoading(true);
        void client
            .agentsContent(asWorkspaceId(activeCwd), selectedAgentType)
            .then((r) => {
                if (cancelled) return;
                setAgentContent(r);
                setAgentContentError(null);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setAgentContentError(e instanceof Error ? e.message : String(e));
                setAgentContent(null);
            })
            .finally(() => {
                if (!cancelled) setAgentContentLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedAgentType, activeCwd, client]);

    const saveAgent = useCallback(
        async (input: AgentSaveInput, previousAgentType?: string) => {
            if (!activeCwd) return;
            setAgentSaving(true);
            try {
                await client.agentsWrite(asWorkspaceId(activeCwd), {
                    runtime: "claude-code",
                    ...input,
                    ...(previousAgentType !== undefined ? { previousAgentType } : {}),
                });
                await reload();
                setSelectedAgentType(input.agentType);
            } finally {
                setAgentSaving(false);
            }
        },
        [activeCwd, client, reload],
    );

    const deleteAgent = useCallback(
        async (agentType: string) => {
            if (!activeCwd) return;
            setAgentSaving(true);
            try {
                await client.agentsDelete(asWorkspaceId(activeCwd), agentType);
                await reload();
            } finally {
                setAgentSaving(false);
            }
        },
        [activeCwd, client, reload],
    );

    return {
        agents,
        agentsError,
        selectedAgentType,
        setSelectedAgentType,
        agentContent,
        agentContentLoading,
        agentContentError,
        agentSaving,
        saveAgent,
        deleteAgent,
    };
}
