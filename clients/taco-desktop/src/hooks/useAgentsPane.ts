import {
    type AgentEntry,
    type AgentRuntime,
    type AgentScope,
    type AgentsContentResult,
    type AgentsRuntimeStatusResult,
    asWorkspaceId,
    type ClaudeCodePermissionMode,
    type CodexAgentConfig,
} from "@taco-ai/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { type ConfigurationScope, filterAgentScope } from "../lib/configurationScope";
import { queryError, refreshQueries, resourceQueryKey } from "../lib/queries/queryClient";
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
    codex?: CodexAgentConfig;
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
    codexRuntimeStatus: AgentsRuntimeStatusResult | null;
    codexStatusLoading: boolean;
    codexInstalling: boolean;
    codexInstallError: string | null;
    refreshCodexRuntime: () => Promise<void>;
    installCodexRuntime: () => Promise<void>;
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
    const queryClient = useQueryClient();
    const enabled = active && !!activeCwd;
    const [selectedAgentType, setSelectedAgentType] = useState<string | null>(null);
    const [agentSaving, setAgentSaving] = useState(false);
    const [codexInstalling, setCodexInstalling] = useState(false);
    const [codexInstallError, setCodexInstallError] = useState<string | null>(null);
    const {
        error: agentsError,
        fail: failAgentsList,
        clearError: clearAgentsError,
    } = useAutoClearError();
    // A mutation must not revive an earlier target/layer, even after navigating back to it.
    const paneGeneration = useRef(0);
    const listQuery = (scope: ConfigurationScope, enabled: boolean) => ({
        queryKey: resourceQueryKey(client, "agents", activeCwd, scope),
        enabled,
        retry: false,
        queryFn: ({ signal }: { signal: AbortSignal }) => {
            signal.throwIfAborted();
            return client.agentsList({
                workspace: asWorkspaceId(activeCwd as string),
                ...(scope === "effective" ? {} : { scope }),
            });
        },
    });
    const catalog = useQuery(listQuery(viewScope, enabled));
    const global = useQuery(listQuery("global", enabled && viewScope === "workspace"));
    const agents = useMemo(
        () => filterAgentScope(catalog.data?.agents ?? [], viewScope),
        [catalog.data, viewScope],
    );
    const selected = agents.find((agent) => agent.agentType === selectedAgentType);
    const contentScope = viewScope === "builtin" ? "builtin" : selected?.scope;
    const content = useQuery({
        queryKey: resourceQueryKey(
            client,
            "agent-content",
            activeCwd,
            viewScope,
            selected?.agentType,
            contentScope,
            selected?.source,
        ),
        enabled: enabled && !!selected,
        retry: false,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.agentsContent({
                workspace: asWorkspaceId(activeCwd as string),
                agentType: selected?.agentType as string,
                ...(contentScope ? { scope: contentScope } : {}),
            });
        },
    });
    const runtime = useQuery({
        queryKey: resourceQueryKey(client, "agent-runtime", "codex"),
        enabled: active,
        retry: false,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.agentsRuntimeStatus({ runtime: "codex" });
        },
    });

    // biome-ignore lint/correctness/useExhaustiveDependencies: each pane identity transition invalidates mutation ownership.
    useEffect(() => {
        paneGeneration.current += 1;
        setAgentSaving(false);
        setSelectedAgentType(null);
        clearAgentsError();
        return () => {
            paneGeneration.current += 1;
        };
    }, [active, activeCwd, viewScope, client, clearAgentsError]);

    useEffect(() => {
        if (!enabled) return;
        setSelectedAgentType((previous) =>
            previous !== null && agents.some((agent) => agent.agentType === previous)
                ? previous
                : (agents[0]?.agentType ?? null),
        );
    }, [enabled, agents]);

    useEffect(() => {
        if (enabled && (catalog.error || (viewScope === "workspace" && global.error))) {
            failAgentsList(catalog.error ?? global.error);
        }
    }, [enabled, viewScope, catalog.error, global.error, failAgentsList]);

    const refreshCodexRuntime = useCallback(async () => {
        setCodexInstallError(null);
        await refreshQueries(queryClient, { queryKey: resourceQueryKey(client, "agent-runtime") });
    }, [client, queryClient]);

    const installCodexRuntime = useCallback(async () => {
        if (codexInstalling) return;
        setCodexInstalling(true);
        setCodexInstallError(null);
        try {
            await client.agentsInstallRuntime({ runtime: "codex" });
            await refreshCodexRuntime();
        } catch (error) {
            setCodexInstallError(error instanceof Error ? error.message : String(error));
        } finally {
            setCodexInstalling(false);
        }
    }, [client, codexInstalling, refreshCodexRuntime]);

    const reload = useCallback(
        async (generation: number, agentTypes: string[], globalWrite: boolean) => {
            const prefix = resourceQueryKey(client, "agents");
            const predicate = ({ queryKey: key }: { queryKey: readonly unknown[] }) => {
                if (key[0] !== prefix[0] || key[1] !== prefix[1]) return false;
                if (key[2] !== "agents" && key[2] !== "agent-content") return false;
                if (key[4] === "builtin") return false;
                const affected =
                    key[3] === activeCwd ||
                    (globalWrite && (key[4] === "global" || key[4] === "effective"));
                return affected && (key[2] === "agents" || agentTypes.includes(key[5] as string));
            };
            const current = () => generation === paneGeneration.current;
            // Hidden completions mark caches stale without interrupting the current reader.
            await queryClient.cancelQueries({ predicate, type: current() ? "all" : "inactive" });
            await queryClient.invalidateQueries(
                { predicate, refetchType: current() ? "active" : "none" },
                { cancelRefetch: false },
            );
        },
        [activeCwd, client, queryClient],
    );

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
                await reload(
                    generation,
                    [input.agentType, previousAgentType ?? input.agentType],
                    input.scope === "global" || previousScope === "global",
                );
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
                await reload(generation, [agentType], scope !== "workspace");
            } finally {
                if (generation === paneGeneration.current) setAgentSaving(false);
            }
        },
        [activeCwd, client, reload],
    );

    return {
        agents,
        globalAgentTypes: ((viewScope === "workspace" ? global.data : catalog.data)?.agents ?? [])
            .filter((agent) => agent.scope === "global")
            .map((agent) => agent.agentType),
        cwdChoices: catalog.data?.cwdChoices ?? [],
        agentsError,
        selectedAgentType,
        setSelectedAgentType,
        agentContent: content.data ?? null,
        agentContentLoading: content.isFetching,
        agentContentError: queryError(content.error)?.message ?? null,
        agentSaving,
        codexRuntimeStatus: runtime.data ?? null,
        codexStatusLoading: runtime.isFetching,
        codexInstalling,
        codexInstallError: codexInstallError ?? queryError(runtime.error)?.message ?? null,
        refreshCodexRuntime,
        installCodexRuntime,
        saveAgent,
        deleteAgent,
    };
}
