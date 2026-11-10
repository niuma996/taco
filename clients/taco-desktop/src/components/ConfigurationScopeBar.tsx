import { Box, Folder, Globe2, Layers3, MessagesSquare } from "lucide-react";
import type { KeyboardEvent, ReactElement } from "react";
import type { ConfigurationTargetOption } from "../hooks/useConfigurationScope";
import { useT } from "../i18n/useI18n";
import type { ConfigurationScope, ConfigurationScopeVariant } from "../lib/configurationScope";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
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
    const scopes: ConfigurationScope[] =
        variant === "target"
            ? []
            : variant === "catalog"
              ? ["effective", "global", "builtin", "workspace"]
              : ["effective"];
    const selectedTarget = targetOptions.find((option) => option.value === targetCwd);
    const TargetIcon = mode === "im" ? MessagesSquare : Folder;
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const current = scopes.indexOf(scope);
        const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (delta === 0 && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? scopes.length - 1
                  : (current + delta + scopes.length) % scopes.length;
        onScopeChange(scopes[index]);
        event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[index]?.focus();
    };
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
                <>
                    <div
                        className="configuration-scope-tabs"
                        role="tablist"
                        aria-label={t("configScope.label")}
                        onKeyDown={onKeyDown}
                    >
                        {scopes.map((value) => {
                            const Icon = ICONS[value];
                            const active = value === scope;
                            return (
                                <button
                                    key={value}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    tabIndex={active ? 0 : -1}
                                    className={`configuration-scope-tab${active ? " active" : ""}`}
                                    onClick={() => onScopeChange(value)}
                                >
                                    <Icon size={14} aria-hidden="true" />
                                    <span>{t(`configScope.${value}`)}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="configuration-scope-description">
                        {scope === "global" && (
                            <span className="configuration-scope-global">~/.taco</span>
                        )}
                        <span className="configuration-scope-hint">{t(hint)}</span>
                    </div>
                </>
            ) : null}
        </div>
    );
}
