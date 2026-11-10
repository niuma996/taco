import { type ImConversationEntry, makeImCwd, parseImCwd } from "@taco-ai/protocol";
import { useMemo, useState } from "react";
import type { WorkspaceMode } from "../components/WorkspaceModeTabs";
import type { ConfigurationScope } from "../lib/configurationScope";
import { lastSegment } from "../lib/workspaceStorage";

export interface ConfigurationTargetOption {
    value: string;
    label: string;
    detail: string;
    kind: "workspace" | "channel";
    channelId?: string;
}

export interface UseConfigurationScopeInput {
    active: boolean;
    mode: WorkspaceMode;
    activeCwd: string | undefined;
    workspaces: Record<string, unknown>;
    conversations: readonly ImConversationEntry[] | null;
}

/** Starts on the main chat target; manual configuration choices never switch chats. */
export function useConfigurationScope({
    active,
    mode,
    activeCwd,
    workspaces,
    conversations,
}: UseConfigurationScopeInput) {
    const targetOptions = useMemo<ConfigurationTargetOption[]>(() => {
        const options = new Map<string, ConfigurationTargetOption>();
        for (const cwd of [...Object.keys(workspaces), ...(activeCwd ? [activeCwd] : [])]) {
            const route = parseImCwd(cwd);
            options.set(cwd, {
                value: cwd,
                label: route ? route.chatId : lastSegment(cwd),
                detail: cwd,
                kind: route ? "channel" : "workspace",
                ...(route ? { channelId: route.channelId } : {}),
            });
        }
        for (const conversation of conversations ?? []) {
            const cwd = makeImCwd(conversation.channelId, conversation.peerId, conversation.chatId);
            options.set(cwd, {
                value: cwd,
                label: conversation.name || conversation.chatId,
                detail: cwd,
                kind: "channel",
                channelId: conversation.channelId,
            });
        }
        return [...options.values()].filter(
            (option) => option.kind === (mode === "im" ? "channel" : "workspace"),
        );
    }, [activeCwd, workspaces, conversations, mode]);
    const chatTarget = targetOptions.find((option) => option.value === activeCwd)?.value;
    const initialTarget = chatTarget ?? targetOptions[0]?.value;
    const [selection, setSelection] = useState({
        active,
        activeCwd,
        mode,
        targets: { [mode]: initialTarget } as Partial<Record<WorkspaceMode, string>>,
        scope: "effective" as ConfigurationScope,
    });
    const remembered = targetOptions.find(
        (option) => option.value === selection.targets[mode],
    )?.value;
    const targetCwd = remembered ?? initialTarget;
    // A category change keeps its last configuration target; pane entry follows the open chat.
    if (
        selection.active !== active ||
        selection.activeCwd !== activeCwd ||
        selection.mode !== mode
    ) {
        const followsChat = (!selection.active && active) || selection.activeCwd !== activeCwd;
        const target = (followsChat ? chatTarget : undefined) ?? remembered ?? initialTarget;
        setSelection({
            active,
            activeCwd,
            mode,
            scope: "effective",
            targets: { ...selection.targets, [mode]: target },
        });
    } else if (selection.targets[mode] !== targetCwd) {
        // Pin an asynchronously discovered default before later activity reorders the list.
        setSelection({ ...selection, targets: { ...selection.targets, [mode]: targetCwd } });
    }
    return {
        mode,
        scope: selection.scope,
        setScope: (scope: ConfigurationScope) => setSelection((current) => ({ ...current, scope })),
        targetCwd,
        targetOptions,
        setTargetCwd: (targetCwd: string) =>
            setSelection((current) => ({
                ...current,
                targets: { ...current.targets, [mode]: targetCwd },
            })),
        hasTarget: targetCwd !== undefined,
    };
}
