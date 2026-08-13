/**
 * PluginsPane — full-screen view for ActivityRail's "Plugins" entry.
 *
 * Four mutually-exclusive sections sourced from extensions.status: Enabled,
 * Disabled, Failed, Unauthorized. Pure view: data + toggles + restart live in
 * App.tsx; a sidecar restart is required for toggles to take effect.
 */

import type {
    ExtensionPermission,
    ExtensionStatusEntry,
    ExtensionsStatusResult,
} from "@taco-ai/protocol";
import type { ReactElement } from "react";
import { Button } from "../components/ui/Button.tsx";
import { Switch } from "../components/ui/Switch.tsx";
import { useT } from "../i18n/useI18n";

export interface PluginsPaneProps {
    status: ExtensionsStatusResult | null;
    loading: boolean;
    error: string | null;
    savingName: string | null;
    onToggle: (name: string, nextDisabled: boolean) => void;
    pendingRestart: boolean;
    restarting: boolean;
    onRestart: () => void;
}

/** permission → i18n key, centralized here so TS flags a missing entry whenever `ExtensionPermission` gains a new member. */
const PERM_LABEL_KEY: Record<ExtensionPermission, string> = {
    context: "plugins.permContext",
    toolCall: "plugins.permToolCall",
    toolResult: "plugins.permToolResult",
    tools: "plugins.permTools",
    systemPrompt: "plugins.permSystemPrompt",
    tags: "plugins.permTags",
};

export function PluginsPane(props: PluginsPaneProps): ReactElement {
    const { t } = useT();
    const { status, loading, error, savingName, onToggle, pendingRestart, restarting, onRestart } =
        props;

    return (
        <div className="plugins-pane">
            <div className="pane-header">
                <span>{t("plugins.title")}</span>
                <span className="pane-subtitle">{t("plugins.subtitle")}</span>
            </div>

            <div className="pane-config-hint">
                <span className="plugins-config-hint-label">taco.json</span>
                <span>{t("plugins.configHint")}</span>
            </div>

            {pendingRestart && (
                <div className="pane-restart-banner">
                    <span>{t("plugins.restartBanner")}</span>
                    <Button size="sm" variant="primary" onClick={onRestart} disabled={restarting}>
                        {restarting ? t("plugins.restarting") : t("plugins.restartNow")}
                    </Button>
                </div>
            )}

            {error && <div className="error-banner">{error}</div>}
            {loading && <div className="pane-loading">{t("plugins.loading")}</div>}

            {status && (
                <div className="plugins-sections">
                    <PluginSection
                        title={t("plugins.sectionEnabled")}
                        empty={status.loaded.length === 0}
                        emptyText={t("plugins.emptyEnabled")}
                    >
                        {status.loaded.map((e) => (
                            <EnabledCard
                                key={e.name}
                                entry={e}
                                saving={savingName === e.name}
                                onDisable={() => onToggle(e.name, true)}
                                permLabel={(p) => t(PERM_LABEL_KEY[p])}
                                t={t}
                            />
                        ))}
                    </PluginSection>

                    <PluginSection
                        title={t("plugins.sectionDisabled")}
                        empty={status.disabled.length === 0}
                        emptyText={t("plugins.emptyDisabled")}
                    >
                        {status.disabled.map((name) => (
                            <DisabledCard
                                key={name}
                                name={name}
                                saving={savingName === name}
                                onEnable={() => onToggle(name, false)}
                            />
                        ))}
                    </PluginSection>

                    <PluginSection
                        title={t("plugins.sectionFailed")}
                        empty={status.failed.length === 0}
                        emptyText={t("plugins.emptyFailed")}
                    >
                        {status.failed.map((f) => (
                            <div key={f.name} className="pane-card plugins-card-failed">
                                <div className="pane-card-header">
                                    <span className="pane-card-name">{f.name}</span>
                                </div>
                                <p className="plugins-card-reason">
                                    {t("plugins.failedReason", { reason: f.reason })}
                                </p>
                            </div>
                        ))}
                    </PluginSection>

                    <PluginSection
                        title={t("plugins.sectionUnauthorized")}
                        empty={status.unauthorized.length === 0}
                        emptyText={t("plugins.emptyUnauthorized")}
                    >
                        {status.unauthorized.map((u) => (
                            <div
                                key={`${u.name}:${u.method}`}
                                className="pane-card plugins-card-unauthorized"
                            >
                                <div className="pane-card-header">
                                    <span className="pane-card-name">{u.name}</span>
                                </div>
                                <p className="plugins-card-reason">
                                    {t("plugins.unauthorizedMethod", { method: u.method })}
                                </p>
                            </div>
                        ))}
                    </PluginSection>
                </div>
            )}
        </div>
    );
}

function PluginSection(props: {
    title: string;
    empty: boolean;
    emptyText: string;
    children: React.ReactNode;
}): ReactElement {
    return (
        <section className="plugins-section">
            <h3 className="pane-section-title">{props.title}</h3>
            {props.empty ? (
                <p className="pane-empty">{props.emptyText}</p>
            ) : (
                <div className="plugins-grid">{props.children}</div>
            )}
        </section>
    );
}

function DisabledCard(props: {
    name: string;
    saving: boolean;
    onEnable: () => void;
}): ReactElement {
    const { name, saving, onEnable } = props;
    return (
        <div className="pane-card plugins-card-disabled">
            <div className="pane-card-header">
                <span className="pane-card-name">{name}</span>
                <Switch
                    checked={false}
                    disabled={saving}
                    onChange={(next) => {
                        if (next) onEnable();
                    }}
                    label={`Enable ${name}`}
                />
            </div>
        </div>
    );
}

function EnabledCard(props: {
    entry: ExtensionStatusEntry;
    saving: boolean;
    onDisable: () => void;
    permLabel: (p: ExtensionPermission) => string;
    t: ReturnType<typeof useT>["t"];
}): ReactElement {
    const { entry, saving, onDisable, permLabel, t } = props;
    const isBuiltin = entry.source === "builtin";
    return (
        <div className="pane-card">
            <div className="pane-card-header">
                <span className="pane-card-name">{entry.name}</span>
                <span className="pane-card-version">v{entry.version}</span>
                <span className="plugins-card-source">
                    {isBuiltin ? t("plugins.sourceBuiltin") : t("plugins.sourceExternal")}
                </span>
                <Switch
                    checked
                    disabled={saving}
                    onChange={(next) => {
                        if (!next) onDisable();
                    }}
                    label={`Disable ${entry.name}`}
                />
            </div>
            <p className="pane-card-desc">{entry.description ?? t("plugins.noDescription")}</p>
            {entry.whenToUse && (
                <p className="plugins-card-when">
                    {t("plugins.whenToUsePrefix")}
                    {entry.whenToUse}
                </p>
            )}
            <div className="plugins-perm-chips">
                {entry.permissions.map((p) => (
                    <span key={p} className="plugins-perm-chip" title={permLabel(p)}>
                        {p}
                    </span>
                ))}
            </div>
            {entry.tags && entry.tags.length > 0 && (
                <div className="plugins-perm-chips">
                    {entry.tags.map((tag) => (
                        <span key={tag} className="plugins-perm-chip">
                            &lt;{tag}&gt;
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
