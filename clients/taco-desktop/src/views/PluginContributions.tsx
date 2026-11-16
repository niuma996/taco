import type {
    ExtensionContributionSummary,
    ExtensionStatusEntry,
    ExtensionWorkspaceStatus,
} from "@taco-ai/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/Button";
import type { useT } from "../i18n/useI18n";
import { type PluginSettingsAccess, PluginSettingsDialog } from "./PluginSettingsDialog";

export function PluginContributions({
    entry,
    t,
    activation,
    settings,
}: {
    entry: ExtensionStatusEntry;
    activation?: ExtensionWorkspaceStatus;
    settings?: PluginSettingsAccess;
    t: ReturnType<typeof useT>["t"];
}): ReactElement | null {
    const [open, setOpen] = useState(false);
    const c = entry.contributions;
    if (!c) return null;
    const rows = (summary: ExtensionContributionSummary) =>
        [
            { key: "Skills", count: summary.skillDirs?.length ?? 0, names: summary.skillDirs },
            {
                key: "CommandRules",
                count: summary.commandPermissionRules?.length ?? 0,
                names: summary.commandPermissionRules,
            },
            { key: "Tools", count: summary.tools.length, names: summary.tools },
            {
                key: "DeferredTools",
                count: summary.deferredTools.length,
                names: summary.deferredTools,
            },
            { key: "Context", count: summary.contextHooks },
            { key: "ToolCall", count: summary.toolCallHooks },
            { key: "ToolResult", count: summary.toolResultHooks },
            { key: "Prompt", count: summary.systemPrompts },
            { key: "Workspace", count: summary.workspaceActivators },
            { key: "Session", count: summary.sessionActivators },
        ].filter(({ count }) => count > 0);
    const registrations = rows(c);
    const workspace = activation ? rows(activation.contributions) : [];
    const capabilities = [...new Set([...registrations, ...workspace].map(({ key }) => key))];
    if (capabilities.length === 0 && !activation && !entry.configSchema) return null;
    return (
        <div className="plugins-contributions">
            <div className="plugins-contributions-summary">
                {activation && (
                    <span className={`plugins-activation plugins-activation--${activation.state}`}>
                        {t(
                            `plugins.activation${activation.state === "active" ? "Active" : activation.state === "failed" ? "Failed" : "Inactive"}`,
                        )}
                    </span>
                )}
                <ul className="plugins-capabilities" aria-label={t("plugins.capabilities")}>
                    {capabilities.map((key) => (
                        <li key={key}>{t(`plugins.capability${key}`)}</li>
                    ))}
                </ul>
                <Button
                    variant="ghost"
                    size="sm"
                    className="plugins-contributions-toggle"
                    aria-haspopup="dialog"
                    onClick={() => setOpen(true)}
                >
                    {t("plugins.showRegistrations")}
                </Button>
            </div>
            {open && (
                <PluginSettingsDialog entry={entry} {...settings} onClose={() => setOpen(false)}>
                    <p className="plugins-registration-hint">{t("plugins.registrationHint")}</p>
                    <RegistrationRows rows={registrations} t={t} />
                    {activation && (
                        <>
                            <p className="plugins-registration-hint">
                                {t("plugins.workspaceContributions")}
                            </p>
                            {activation.reason && (
                                <p className="plugins-registration-hint">
                                    {t(reasonKey(activation.reason), { reason: activation.reason })}
                                </p>
                            )}
                            <RegistrationRows rows={workspace} t={t} />
                        </>
                    )}
                    {!activation && (c.workspaceActivators > 0 || c.sessionActivators > 0) && (
                        <p className="plugins-registration-hint">
                            {t("plugins.registrationScopeHint")}
                        </p>
                    )}
                </PluginSettingsDialog>
            )}
        </div>
    );
}

function reasonKey(reason: string): string {
    const keys: Record<string, string> = {
        notGitRepository: "plugins.inactiveNotGit",
        noProjectManifests: "plugins.inactiveNoManifests",
        imWorkspace: "plugins.inactiveIm",
        configurationDisabled: "plugins.inactiveConfiguration",
    };
    return keys[reason] ?? "plugins.activationReason";
}

function RegistrationRows({
    rows,
    t,
}: {
    rows: Array<{ key: string; count: number; names?: string[] }>;
    t: ReturnType<typeof useT>["t"];
}): ReactElement {
    return (
        <dl className="plugins-registration-list">
            {rows.map(({ key, count, names }) => (
                <div key={key} className="plugins-registration-row">
                    <dt>{t(`plugins.registration${key}`)}</dt>
                    <dd>{count}</dd>
                    {names && (
                        <dd className="plugins-registration-names">
                            {names.map((name) => (
                                <code key={name}>{name}</code>
                            ))}
                        </dd>
                    )}
                </div>
            ))}
        </dl>
    );
}
