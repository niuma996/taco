import type { ExtensionStatusEntry } from "@taco-ai/protocol";
import { ChevronDown } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/Button";
import type { useT } from "../i18n/useI18n";

export function PluginContributions({
    entry,
    t,
}: {
    entry: ExtensionStatusEntry;
    t: ReturnType<typeof useT>["t"];
}): ReactElement | null {
    const [expanded, setExpanded] = useState(false);
    const detailsId = useId();
    const c = entry.contributions;
    if (!c) return null;
    const registrations = [
        { key: "Tools", count: c.tools.length, names: c.tools },
        { key: "DeferredTools", count: c.deferredTools.length, names: c.deferredTools },
        { key: "Context", count: c.contextHooks },
        { key: "ToolCall", count: c.toolCallHooks },
        { key: "ToolResult", count: c.toolResultHooks },
        { key: "Prompt", count: c.systemPrompts },
        { key: "Workspace", count: c.workspaceActivators },
        { key: "Session", count: c.sessionActivators },
    ].filter(({ count }) => count > 0);
    if (registrations.length === 0) return null;
    return (
        <div className="plugins-contributions">
            <div className="plugins-contributions-summary">
                <ul className="plugins-capabilities" aria-label={t("plugins.capabilities")}>
                    {registrations.map(({ key }) => (
                        <li key={key}>{t(`plugins.capability${key}`)}</li>
                    ))}
                </ul>
                <Button
                    variant="ghost"
                    size="sm"
                    className="plugins-contributions-toggle"
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    onClick={() => setExpanded(!expanded)}
                >
                    {t(expanded ? "plugins.hideRegistrations" : "plugins.showRegistrations")}
                    <ChevronDown aria-hidden="true" />
                </Button>
            </div>
            {expanded && (
                <div id={detailsId} className="plugins-registration-details">
                    <p className="plugins-registration-hint">{t("plugins.registrationHint")}</p>
                    <dl className="plugins-registration-list">
                        {registrations.map(({ key, count, names }) => (
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
                    {(c.workspaceActivators > 0 || c.sessionActivators > 0) && (
                        <p className="plugins-registration-hint">
                            {t("plugins.registrationScopeHint")}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
