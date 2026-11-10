import { type ImConversationEntry, makeImCwd } from "@taco-ai/protocol";
import { useEffect, useMemo, useState } from "react";
import type { ConfigurationScope, ConfigurationScopeVariant } from "../lib/configurationScope";

export interface ConfigurationTargetOption {
    value: string;
    label: string;
    detail?: string;
}

function workspaceLabel(cwd: string): string {
    return (
        cwd
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || cwd
    );
}

export interface UseConfigurationScopeInput {
    variant: ConfigurationScopeVariant;
    activeCwd: string | undefined;
    workspaces: Record<string, unknown>;
    conversations: readonly ImConversationEntry[] | null;
}

/** Owns configuration-pane targets independently from the chat's active workspace. */
export function useConfigurationScope({
    variant,
    activeCwd,
    workspaces,
    conversations,
}: UseConfigurationScopeInput) {
    const workspaceOptions = useMemo<ConfigurationTargetOption[]>(
        () =>
            Object.keys(workspaces)
                .filter((cwd) => !cwd.startsWith("im://"))
                .map((cwd) => ({ value: cwd, label: workspaceLabel(cwd), detail: cwd })),
        [workspaces],
    );
    const channelOptions = useMemo<ConfigurationTargetOption[]>(
        () =>
            (conversations ?? []).map((conversation) => {
                const value = makeImCwd(
                    conversation.channelId,
                    conversation.peerId,
                    conversation.chatId,
                );
                return {
                    value,
                    label: conversation.peerId,
                    detail: `${conversation.channelId} · ${conversation.chatId}`,
                };
            }),
        [conversations],
    );
    const initialWorkspace =
        activeCwd && !activeCwd.startsWith("im://")
            ? activeCwd
            : (workspaceOptions[0]?.value ?? "");
    const [scope, setScope] = useState<ConfigurationScope>(
        variant === "catalog" ? "global" : "workspace",
    );
    const [workspaceCwd, setWorkspaceCwd] = useState(initialWorkspace);
    const [channelCwd, setChannelCwd] = useState("");

    useEffect(() => {
        if (workspaceCwd && workspaceOptions.some((option) => option.value === workspaceCwd))
            return;
        setWorkspaceCwd(initialWorkspace);
    }, [initialWorkspace, workspaceCwd, workspaceOptions]);

    useEffect(() => {
        if (channelCwd && channelOptions.some((option) => option.value === channelCwd)) return;
        setChannelCwd(channelOptions[0]?.value ?? "");
    }, [channelCwd, channelOptions]);

    const targetCwd =
        scope === "channel" ? channelCwd || undefined : workspaceCwd || channelCwd || undefined;
    const targetOptions = scope === "channel" ? channelOptions : workspaceOptions;
    const setTargetCwd = (cwd: string) => {
        if (scope === "channel") setChannelCwd(cwd);
        else setWorkspaceCwd(cwd);
    };

    return {
        scope,
        setScope,
        targetCwd,
        targetOptions,
        setTargetCwd,
        hasTarget: targetCwd !== undefined,
    };
}
