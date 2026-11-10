import {
    type AgentEntry,
    type AgentRuntime,
    type AgentScope,
    type AgentsContentResult,
    asWorkspaceId,
    type ClaudeCodePermissionMode,
} from "@taco-ai/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { type ConfigurationScope, filterAgentScope } from "../lib/configurationScope";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface AgentSaveInput {
    scope: AgentScope;
    agentType: string;
    description: string;
    whenToUse?: string;
    runtime: AgentRuntime;
    maxTurns: number;
    timeoutMinutes?: number;
    systemPrompt: string;
    tools?: string[];
    permissionMode?: ClaudeCodePermissionMode;
    cwd?: string;
}

export interface UseAgentsPaneResult {
    agents: AgentEntry[];
    globalAgentTypes: string[];
    cwdChoices: string[];
    agentsError: string | null;
    selectedAgentType: string | null;
    setSelectedAgentType: (type: string | null) => void;
    agentContent: AgentsContentResult | null;
    agentContentLoading: boolean;
    agentContentError: string | null;
    agentSaving: boolean;
    saveAgent: (
        input: AgentSaveInput,
        previousAgentType?: string,
        previousScope?: AgentScope,
    ) => Promise<void>;
    deleteAgent: (agentType: string, scope?: AgentScope) => Promise<void>;
}

/** Loads the selected target/layer and owns scope-correct agent mutations. */
export function useAgentsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    viewScope: ConfigurationScope = "effective",
): UseAgentsPaneResult {
    const [catalog, setCatalog] = useState<AgentEntry[]>([]);
    const [globalAgentTypes, setGlobalAgentTypes] = useState<string[]>([]);
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
    const requestCounter = useRef(0);
    // A mutation must not revive an earlier target/layer, even after navigating back to it.
    const paneGeneration = useRef(0);
    const agents = useMemo(() => filterAgentScope(catalog, viewScope), [catalog, viewScope]);

    const reload = useCallback(async () => {
        if (!activeCwd) return;
        const request = ++requestCounter.current;
        const layer = viewScope === "effective" ? undefined : viewScope;
        const workspace = asWorkspaceId(activeCwd);
        const [result, globalResult] = await Promise.all([
            client.agentsList({ workspace, ...(layer ? { scope: layer } : {}) }),
            viewScope === "workspace"
                ? client.agentsList({ workspace, scope: "global" })
                : Promise.resolve(null),
        ]);
        if (request !== requestCounter.current) return;
        setCatalog(result.agents);
        setGlobalAgentTypes(
            (globalResult?.agents ?? result.agents)
                .filter((agent) => agent.scope === "global")
                .map((agent) => agent.agentType),
        );
        setCwdChoices(result.cwdChoices ?? []);
        const visible = filterAgentScope(result.agents, viewScope);
        setSelectedAgentType((previous) =>
            previous !== null && visible.some((agent) => agent.agentType === previous)
                ? previous
                : (visible[0]?.agentType ?? null),
        );
    }, [activeCwd, client, viewScope]);

    useEffect(() => {
        const generation = ++paneGeneration.current;
        setAgentSaving(false);
        if (active) {
            setCatalog([]);
            setSelectedAgentType(null);
            setAgentContent(null);
            setAgentContentError(null);
            clearAgentsError();
            if (activeCwd) {
                reload().catch((error: unknown) => {
                    if (generation !== paneGeneration.current) return;
                    console.error("[useAgentsPane] agentsList failed:", error);
                    failAgentsList(error);
                });
            }
        }
        return () => {
            paneGeneration.current += 1;
            requestCounter.current += 1;
        };
    }, [active, activeCwd, reload, clearAgentsError, failAgentsList]);

    useEffect(() => {
        let cancelled = false;
        setAgentContent(null);
        setAgentContentError(null);
        setAgentContentLoading(false);
        const selected = agents.find((agent) => agent.agentType === selectedAgentType);
        if (!active || !selected || !activeCwd) return;
        setAgentContentLoading(true);
        void client
            .agentsContent({
                workspace: asWorkspaceId(activeCwd),
                agentType: selected.agentType,
                ...(viewScope === "builtin"
                    ? { scope: "builtin" as const }
                    : selected.scope
                      ? { scope: selected.scope }
                      : {}),
            })
            .then((result) => {
                if (!cancelled) setAgentContent(result);
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setAgentContentError(error instanceof Error ? error.message : String(error));
                    setAgentContent(null);
                }
            })
            .finally(() => {
                if (!cancelled) setAgentContentLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [active, selectedAgentType, agents, activeCwd, client, viewScope]);

    const saveAgent = useCallback(
        async (input: AgentSaveInput, previousAgentType?: string, previousScope?: AgentScope) => {
            if (!activeCwd) return;
            const generation = paneGeneration.current;
            setAgentSaving(true);
            try {
                await client.agentsWrite({
                    workspace: asWorkspaceId(activeCwd),
                    ...input,
                    ...(previousAgentType !== undefined ? { previousAgentType } : {}),
                    ...(previousScope !== undefined ? { previousScope } : {}),
                });
                if (generation !== paneGeneration.current) return;
                await reload();
                if (generation === paneGeneration.current) setSelectedAgentType(input.agentType);
            } finally {
                if (generation === paneGeneration.current) setAgentSaving(false);
            }
        },
        [activeCwd, client, reload],
    );

    const deleteAgent = useCallback(
        async (agentType: string, scope?: AgentScope) => {
            if (!activeCwd) return;
            const generation = paneGeneration.current;
            setAgentSaving(true);
            try {
                await client.agentsDelete({
                    workspace: asWorkspaceId(activeCwd),
                    agentType,
                    ...(scope ? { scope } : {}),
                });
                if (generation !== paneGeneration.current) return;
                await reload();
            } finally {
                if (generation === paneGeneration.current) setAgentSaving(false);
            }
        },
        [activeCwd, client, reload],
    );

    return {
        agents,
        globalAgentTypes,
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
