/**
 * McpSection — MCP server list, health probing, and CRUD operations.
 *
 * Reads the masked mcpServers summary from globalConfig and probes live
 * connectivity via mcp.listServers. Mutations go through the per-entry MCP
 * config RPCs (mcp.createConfig / mcp.updateConfig / mcp.deleteConfig) — never a
 * settings.write of the full array, which would clobber the sensitive fields
 * (command/args/env/headers/url) that settings.get masks. The full single config
 * is fetched via mcp.getConfig only when a user opens the edit form.
 *
 * Caveat — MCP config changes take effect only after a sidecar restart. The
 * runtime candidate set (discoverMcpTools) is built once per workspace at attach
 * time; toggling enabled / editing alwaysLoaded / adding a new server only
 * changes what is on disk. The UI exposes an "Apply & restart" button to make
 * this visible.
 */

import type { McpServerConfig, McpServerConfigView, McpServerView } from "@taco-ai/protocol";
import { Power, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAutoClearError } from "../../hooks/primitives/useAutoClearError.ts";
import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useT } from "../../i18n/useI18n.ts";
import { applyGlobalConfig, getGlobalConfig } from "../../lib/globalConfig.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { McpServerCard } from "./McpServerCard.tsx";
import { McpServerForm } from "./McpServerForm.tsx";

export interface McpSectionProps {
    client: TacoClient;
    /** Triggers sidecar disposeAll + re-ensure — same path DebugTab uses. */
    onRestart: () => Promise<void>;
}

type Panel = { kind: "list" } | { kind: "add" } | { kind: "edit"; server: McpServerConfig };

export function McpSection(props: McpSectionProps) {
    const { t } = useT();
    const globalState = useGlobalConfig();

    const [servers, setServers] = useState<McpServerConfigView[]>(
        () => getGlobalConfig().global.mcpServers ?? [],
    );
    const [views, setViews] = useState<Map<string, McpServerView>>(new Map());
    const [refreshing, setRefreshing] = useState(false);
    /** Transient probe errors (RPC failures, not per-server connect failures). */
    const [probeError, setProbeError] = useState<string | null>(null);
    const [restarting, setRestarting] = useState(false);
    const [restartError, setRestartError] = useState<string | null>(null);
    const [restarted, setRestarted] = useState(false);
    const [panel, setPanel] = useState<Panel>({ kind: "list" });
    /** A config mutation (create/update/delete) is in flight — disables CRUD. */
    const [mutating, setMutating] = useState(false);
    const {
        error: mutationError,
        fail: failMutation,
        clearError: clearMutationError,
    } = useAutoClearError();

    // Sync with globalConfig on external changes. applyGlobalConfig replaces
    // `global` with a new object every write, so the reference is not stable —
    // using `globalState.global` as the dep means we re-sync whenever any field
    // changes, which is what we want.
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync on any global write
    useEffect(() => {
        setServers(getGlobalConfig().global.mcpServers ?? []);
    }, [globalState.global]);

    // Probe all servers on mount and whenever the server set's membership
    // changes. Re-probing on every cfg mutation (same id, same transport) would
    // be a no-op, so the length is a cheap stand-in for "did the set change".
    const refresh = useCallback(
        async (forceProbe = false) => {
            setRefreshing(true);
            setProbeError(null);
            try {
                const result = await props.client.mcpListServers({ forceProbe });
                const map = new Map<string, McpServerView>();
                for (const v of result.servers) map.set(v.id, v);
                setViews(map);
            } catch (err) {
                setProbeError(err instanceof Error ? err.message : String(err));
            } finally {
                setRefreshing(false);
            }
        },
        [props.client],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: probe on membership change only
    useEffect(() => {
        if (panel.kind === "list") void refresh();
    }, [panel.kind, servers.length, refresh]);

    /** Update the local list and the global cache so a remount / other settings
     * tab sees the new server set (mutations bypass settings.write). */
    const commitServers = (next: McpServerConfigView[]) => {
        setServers(next);
        applyGlobalConfig({ ...getGlobalConfig().global, mcpServers: next });
    };

    const handleToggle = async (id: string, enabled: boolean) => {
        setRestarted(false);
        setMutating(true);
        try {
            const { server } = await props.client.mcpUpdateConfig(id, { enabled });
            commitServers(servers.map((s) => (s.id === id ? server : s)));
        } catch (err) {
            // Toggle/delete don't open a form, so a failed save leaves no retry
            // affordance — swallow to avoid an unhandled rejection. The error
            // banner still surfaces the cause.
            failMutation(err);
        } finally {
            setMutating(false);
        }
    };

    const handleDelete = async (id: string) => {
        setRestarted(false);
        setMutating(true);
        try {
            await props.client.mcpDeleteConfig(id);
            commitServers(servers.filter((s) => s.id !== id));
        } catch (err) {
            failMutation(err);
        } finally {
            setMutating(false);
        }
    };

    const handleEdit = async (view: McpServerConfigView) => {
        // The list only holds the masked view, so fetch the full entry before
        // opening the form — editing a view directly would strip the sensitive
        // fields on save.
        clearMutationError();
        try {
            const { config } = await props.client.mcpGetConfig(view.id);
            setPanel({ kind: "edit", server: config });
        } catch (err) {
            failMutation(err);
        }
    };

    const handleSave = async (cfg: McpServerConfig) => {
        setRestarted(false);
        setMutating(true);
        try {
            if (panel.kind === "edit") {
                // The form output doubles as the update patch — the server
                // merges field-wise, so fields the form does not surface
                // (e.g. enabled:false) survive.
                const { server } = await props.client.mcpUpdateConfig(cfg.id, cfg);
                commitServers(servers.map((s) => (s.id === cfg.id ? server : s)));
            } else {
                const { server } = await props.client.mcpCreateConfig(cfg);
                commitServers([...servers, server]);
            }
        } catch (err) {
            // Keep the form open with the user's input so they can retry.
            failMutation(err);
            return;
        } finally {
            setMutating(false);
        }
        setPanel({ kind: "list" });
        // Auto-restart so the edit feels atomic; the manual button covers
        // batched edits.
        await applyAndRestart();
    };

    const applyAndRestart = async () => {
        setRestarting(true);
        setRestartError(null);
        setRestarted(false);
        try {
            await props.onRestart();
            setRestarted(true);
        } catch (err) {
            setRestartError(err instanceof Error ? err.message : String(err));
        } finally {
            setRestarting(false);
        }
    };

    const existingIds = servers.map((s) => s.id);

    return (
        <section className="settings-tab">
            <div className="mcp-section-head">
                <div>
                    <h3>{t("settings.mcpServersTitle")}</h3>
                    <p className="settings-tab-desc">{t("settings.mcpServersDesc")}</p>
                    <p className="settings-tab-desc mcp-restart-hint">
                        {t("settings.mcpServersRestartHint")}
                    </p>
                </div>
                <div className="mcp-section-actions">
                    <button
                        type="button"
                        className="settings-btn"
                        onClick={(e) => void refresh(e.shiftKey)}
                        disabled={refreshing || mutating || restarting}
                        title={t("settings.mcpServersRefreshHint")}
                    >
                        <RefreshCw
                            size={14}
                            aria-hidden="true"
                            className={refreshing ? "spin" : ""}
                        />
                        {t("settings.mcpServersRefresh")}
                    </button>
                    <button
                        type="button"
                        className="settings-btn"
                        onClick={() => setPanel({ kind: "add" })}
                        disabled={mutating || restarting}
                    >
                        {t("settings.mcpServerAddBtn")}
                    </button>
                    <button
                        type="button"
                        className="settings-btn mcp-restart-btn"
                        onClick={() => void applyAndRestart()}
                        disabled={mutating || restarting}
                        title={t("settings.mcpServersApplyAndRestartHint")}
                    >
                        <Power size={14} aria-hidden="true" />
                        {restarting
                            ? t("settings.mcpServersRestarting")
                            : t("settings.mcpServersApplyAndRestart")}
                    </button>
                </div>
            </div>

            {probeError && (
                <div className="error-banner">
                    {t("settings.mcpServersProbeError", { error: probeError })}
                </div>
            )}
            {restartError && <div className="error-banner">{restartError}</div>}
            {restarted && servers.length > 0 && (
                <div className="mcp-info-banner">{t("settings.mcpServersRestarted")}</div>
            )}

            {servers.length === 0 ? (
                <p className="settings-tab-desc">{t("settings.mcpServersEmpty")}</p>
            ) : (
                <div className="mcp-server-list">
                    {servers.map((cfg) => (
                        <McpServerCard
                            key={cfg.id}
                            cfg={cfg}
                            view={views.get(cfg.id)}
                            tools={views.get(cfg.id)?.tools ?? []}
                            disabled={mutating || restarting}
                            onToggle={handleToggle}
                            onEdit={(c) => void handleEdit(c)}
                            onDelete={handleDelete}
                        />
                    ))}
                </div>
            )}

            {panel.kind === "add" && (
                <McpServerForm
                    existingIds={existingIds}
                    saving={mutating || restarting}
                    onSave={(cfg) => void handleSave(cfg)}
                    onCancel={() => setPanel({ kind: "list" })}
                />
            )}
            {panel.kind === "edit" && (
                <McpServerForm
                    existing={panel.server}
                    existingIds={existingIds}
                    saving={mutating || restarting}
                    onSave={(cfg) => void handleSave(cfg)}
                    onCancel={() => setPanel({ kind: "list" })}
                />
            )}

            {mutationError && <div className="error-banner">{mutationError}</div>}
        </section>
    );
}
