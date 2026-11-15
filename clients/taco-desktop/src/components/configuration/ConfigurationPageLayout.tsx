import type { ImConversationEntry } from "@taco-ai/protocol";
import type { ReactNode } from "react";
import type { useConfigurationScope } from "../../hooks/useConfigurationScope";
import type { TacoClient } from "../../lib/clients/tacoClient";
import type { ConfigurationScopeVariant } from "../../lib/configurationScope";
import { ConfigurationScopeBar } from "../ConfigurationScopeBar";
import type { WorkspaceMode } from "../WorkspaceModeTabs";

export interface ConfigurationControllerProps {
    active: boolean;
    client: TacoClient;
    mode: WorkspaceMode;
    activeCwd: string | undefined;
    workspaces: Record<string, unknown>;
    conversations: readonly ImConversationEntry[] | null;
    conversationsLoading: boolean;
    conversationsError: string | null;
    onRetryTargets: () => void;
}

interface ConfigurationPageLayoutProps
    extends Pick<
        ConfigurationControllerProps,
        "mode" | "conversations" | "conversationsLoading" | "conversationsError" | "onRetryTargets"
    > {
    variant: ConfigurationScopeVariant;
    configuration: ReturnType<typeof useConfigurationScope>;
    children: ReactNode;
}

export function ConfigurationPageLayout({
    variant,
    configuration,
    mode,
    conversations,
    conversationsLoading,
    conversationsError,
    onRetryTargets,
    children,
}: ConfigurationPageLayoutProps) {
    return (
        <div className="configuration-pane">
            <ConfigurationScopeBar
                variant={variant}
                {...configuration}
                onScopeChange={configuration.setScope}
                onTargetChange={configuration.setTargetCwd}
                targetsLoading={
                    mode === "im" &&
                    (conversationsLoading || (conversations === null && !conversationsError))
                }
                targetsError={mode === "im" ? conversationsError : null}
                onRetryTargets={onRetryTargets}
            />
            <div className="configuration-pane-body">{children}</div>
        </div>
    );
}
