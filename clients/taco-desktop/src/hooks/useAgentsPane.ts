import {
    type AgentEntry,
    type AgentRuntime,
    type AgentScope,
    type AgentsContentResult,
    asWorkspaceId,
    type ClaudeCodePermissionMode,
} from "@taco-ai/protocol";
import { useCallback, useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface AgentSaveInput {
    scope: AgentScope;
    agentType: string;
    description: string;
    whenToUse?: string;
    runtime: AgentRuntime;
    maxTurns: number;
    systemPrompt: string;
    /** `claude-code` only; omitted = Claude Code's full preset. */
    tools?: string[];
    /** `claude-code` only; omitted = "auto". */
    permissionMode?: ClaudeCodePermissionMode;
    /** `claude-code` only: the directory it runs in. */
    cwd?: string;
}

export interface UseAgentsPaneResult {
    agents: AgentEntry[];
    /** Directories a Claude Code agent may run in: the workspace's own first, then its associations. */
    cwdChoices: string[];
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
    const [cwdChoices, setCwdChoices] = useState<string[]>([]);
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
        const r = await client.agentsList({ workspace: asWorkspaceId(activeCwd) });
        setAgents(r.agents);
        // Absent from a sidecar older than the field; the form then saves no
        // directory and the agent runs in the workspace, as before.
        setCwdChoices(r.cwdChoices ?? []);
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
            .agentsContent({ workspace: asWorkspaceId(activeCwd), agentType: selectedAgentType })
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
                await client.agentsWrite({
                    workspace: asWorkspaceId(activeCwd),
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
                await client.agentsDelete({ workspace: asWorkspaceId(activeCwd), agentType });
                await reload();
            } finally {
                setAgentSaving(false);
            }
        },
        [activeCwd, client, reload],
    );

    return {
        agents,
        cwdChoices,
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
