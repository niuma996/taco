import { Folder, Globe2, Layers3, MessagesSquare } from "lucide-react";
import type { KeyboardEvent, ReactElement } from "react";
import type { ConfigurationTargetOption } from "../hooks/useConfigurationScope";
import { useT } from "../i18n/useI18n";
import type { ConfigurationScope, ConfigurationScopeVariant } from "../lib/configurationScope";
import { Select } from "./ui/Select";

export interface ConfigurationScopeBarProps {
    variant: ConfigurationScopeVariant;
    scope: ConfigurationScope;
    onScopeChange: (scope: ConfigurationScope) => void;
    targetCwd: string | undefined;
    targetOptions: readonly ConfigurationTargetOption[];
    onTargetChange: (cwd: string) => void;
}

const ICONS = { global: Globe2, workspace: Folder, channel: MessagesSquare, effective: Layers3 };

/** Scope navigation for configuration panes; it never changes the chat workspace. */
export function ConfigurationScopeBar({
    variant,
    scope,
    onScopeChange,
    targetCwd,
    targetOptions,
    onTargetChange,
}: ConfigurationScopeBarProps): ReactElement {
    const { t } = useT();
    const scopes: ConfigurationScope[] =
        variant === "catalog"
            ? ["global", "workspace", "channel", "effective"]
            : ["workspace", "channel"];
    const selectedTarget = targetOptions.find((option) => option.value === targetCwd);
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

    return (
        <div className="configuration-scope">
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
            <div className="configuration-scope-context">
                {scope === "global" ? (
                    <span className="configuration-scope-global">~/.taco</span>
                ) : targetOptions.length > 0 && targetCwd ? (
                    <Select
                        value={targetCwd}
                        onValueChange={onTargetChange}
                        options={targetOptions.map((option) => ({
                            value: option.value,
                            label: option.label,
                        }))}
                        label={t("configScope.targetLabel")}
                        className="configuration-scope-select"
                    />
                ) : (
                    <span className="configuration-scope-empty">
                        {t(
                            scope === "channel"
                                ? "configScope.noChannel"
                                : "configScope.noWorkspace",
                        )}
                    </span>
                )}
                <span className="configuration-scope-hint">
                    {scope === "global"
                        ? t("configScope.globalHint")
                        : scope === "workspace"
                          ? t(
                                variant === "runtime"
                                    ? "configScope.runtimeHint"
                                    : "configScope.workspaceHint",
                            )
                          : scope === "channel"
                            ? t("configScope.channelHint")
                            : t("configScope.effectiveHint")}
                </span>
                {selectedTarget?.detail && (
                    <span className="configuration-scope-path" title={selectedTarget.detail}>
                        {selectedTarget.detail}
                    </span>
                )}
            </div>
        </div>
    );
}
