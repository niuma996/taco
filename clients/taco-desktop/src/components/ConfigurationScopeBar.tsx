import { Box, Folder, Globe2, Layers3, MessagesSquare } from "lucide-react";
import { type ReactElement, useId } from "react";
import type { ConfigurationTargetOption } from "../hooks/useConfigurationScope";
import { useT } from "../i18n/useI18n";
import type { ConfigurationScope, ConfigurationScopeVariant } from "../lib/configurationScope";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { TabList } from "./ui/TabList";
import type { WorkspaceMode } from "./WorkspaceModeTabs";

export interface ConfigurationScopeBarProps {
    variant: ConfigurationScopeVariant;
    mode?: WorkspaceMode;
    targetsLoading?: boolean;
    targetsError?: string | null;
    onRetryTargets?: () => void;
    scope: ConfigurationScope;
    onScopeChange: (scope: ConfigurationScope) => void;
    targetCwd: string | undefined;
    targetOptions: readonly ConfigurationTargetOption[];
    onTargetChange: (cwd: string) => void;
}

const ICONS = { global: Globe2, workspace: Folder, builtin: Box, effective: Layers3 };

/** The selected chat directory and its configuration layers are independent controls. */
export function ConfigurationScopeBar({
    variant,
    mode = "workspace",
    targetsLoading = false,
    targetsError,
    onRetryTargets,
    scope,
    onScopeChange,
    targetCwd,
    targetOptions,
    onTargetChange,
}: ConfigurationScopeBarProps): ReactElement {
    const { t } = useT();
    const descriptionId = useId();
    const scopes: ConfigurationScope[] =
        variant === "target"
            ? []
            : variant === "catalog"
              ? ["effective", "global", "builtin", "workspace"]
              : ["effective"];
    const selectedTarget = targetOptions.find((option) => option.value === targetCwd);
    const TargetIcon = mode === "im" ? MessagesSquare : Folder;
    const hint =
        variant === "target"
            ? ""
            : variant === "runtime"
              ? "configScope.runtimeHint"
              : scope === "workspace" && selectedTarget?.kind === "channel"
                ? "configScope.channelDirectoryHint"
                : `configScope.${scope}Hint`;
    return (
        <div className="configuration-scope">
            <div className="configuration-scope-context" aria-busy={targetsLoading}>
                <TargetIcon size={15} aria-hidden="true" />
                {targetOptions.length > 0 && targetCwd ? (
                    <Select
                        value={targetCwd}
                        onValueChange={onTargetChange}
                        options={targetOptions.map((option) => ({
                            value: option.value,
                            label: targetOptions.some(
                                (other) =>
                                    other.value !== option.value && other.label === option.label,
                            )
                                ? `${option.label} · ${option.detail}`
                                : option.label,
                            badge: option.channelId ?? t("workspaceMode.workspace"),
                        }))}
                        label={t("configScope.targetLabel")}
                        aria-describedby={scopes.length > 0 ? descriptionId : undefined}
                        className="configuration-scope-select"
                    />
                ) : (
                    <span className="configuration-scope-empty" role="status">
                        {t(
                            targetsLoading
                                ? "conversationNav.loading"
                                : targetsError
                                  ? "conversationNav.loadFailed"
                                  : mode === "im"
                                    ? "configScope.noChannel"
                                    : "configScope.noTarget",
                        )}
                    </span>
                )}
                {selectedTarget && (
                    <span className="configuration-scope-path" title={selectedTarget.detail}>
                        {selectedTarget.detail}
                    </span>
                )}
                {targetsError && onRetryTargets && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="configuration-scope-retry"
                        onClick={onRetryTargets}
                        disabled={targetsLoading}
                        title={targetsError}
                    >
                        {t("conversationNav.retry")}
                    </Button>
                )}
            </div>
            {scopes.length > 0 ? (
                <div className="configuration-scope-source">
                    <TabList
                        className="configuration-scope-tabs"
                        label={t("configScope.label")}
                        value={scope}
                        onValueChange={onScopeChange}
                        items={scopes.map((value) => {
                            const Icon = ICONS[value];
                            return {
                                value,
                                label: t(`configScope.${value}`),
                                icon: <Icon size={14} aria-hidden="true" />,
                            };
                        })}
                    />
                    <div className="configuration-scope-description" id={descriptionId}>
                        {scope === "global" && (
                            <span className="configuration-scope-global">~/.taco</span>
                        )}
                        <span className="configuration-scope-hint">{t(hint)}</span>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
