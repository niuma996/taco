/**
 * McpServerCard — one MCP server row in the settings list.
 * Shows id, transport badge, health status, tool count, enabled toggle, edit, delete.
 */

import type { McpServerConfigView, McpServerView } from "@taco-ai/protocol";
import { Pencil, Trash2 } from "lucide-react";
import { useT } from "../../i18n/useI18n.ts";
import { Switch } from "../ui/Switch.tsx";

export interface McpServerCardProps {
    /** Masked server summary — never carries command/args/env/headers/url. */
    cfg: McpServerConfigView;
    /** Live health snapshot — undefined means not yet probed. */
    view?: McpServerView;
    /** The MCP-side raw tool names, for display. */
    tools: string[];
    disabled: boolean;
    onToggle: (id: string, enabled: boolean) => void;
    /** Opens edit — the caller fetches the full config via mcp.getConfig. */
    onEdit: (cfg: McpServerConfigView) => void;
    onDelete: (id: string) => void;
}

export function McpServerCard(props: McpServerCardProps) {
    const { t } = useT();
    const { cfg, view, tools, disabled } = props;

    const status = view?.status;
    const ok = status === "ok";
    const skipped = status === "skipped";
    const errorMsg = status === "error" ? view?.connectError : undefined;
    const isEnabled = cfg.enabled !== false;

    return (
        <div
            className={`mcp-server-card${isEnabled ? "" : " mcp-server-card--disabled"}`}
            title={isEnabled ? undefined : t("settings.mcpServerDisabledHint")}
        >
            <div className="mcp-server-card-head">
                <div className="mcp-server-card-info">
                    <span className="mcp-server-name">{cfg.id}</span>
                    <span className="mcp-server-badge">{cfg.transport}</span>
                    {!isEnabled && (
                        <span className="mcp-server-disabled-badge">
                            {t("settings.mcpServerDisabled")}
                        </span>
                    )}
                    {ok ? (
                        <span className="mcp-server-status mcp-server-status--ok">
                            {t("settings.mcpServerStatusOk", {
                                count: view?.toolCount ?? tools.length,
                            })}
                        </span>
                    ) : status === "error" ? (
                        <span
                            className="mcp-server-status mcp-server-status--error"
                            title={errorMsg}
                        >
                            {t("settings.mcpServerStatusError")}
                        </span>
                    ) : skipped ? (
                        <span
                            className="mcp-server-status"
                            title={t("settings.mcpServerStatusSkippedHint")}
                        >
                            {t("settings.mcpServerStatusSkipped")}
                        </span>
                    ) : (
                        <span className="mcp-server-status">
                            {t("settings.mcpServerStatusUnknown")}
                        </span>
                    )}
                </div>
                <div className="mcp-server-card-actions">
                    <Switch
                        checked={cfg.enabled !== false}
                        disabled={disabled}
                        onChange={(checked) => props.onToggle(cfg.id, checked)}
                        label={t("settings.mcpServerToggleEnabled")}
                    />
                    <button
                        type="button"
                        className="icon-button"
                        disabled={disabled}
                        title={t("settings.mcpServerEditBtn")}
                        aria-label={t("settings.mcpServerEditBtn")}
                        onClick={() => props.onEdit(cfg)}
                    >
                        <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        className="icon-button provider-row-icon provider-row-delete"
                        disabled={disabled}
                        title={t("settings.mcpServerDelete")}
                        aria-label={t("settings.mcpServerDelete")}
                        onClick={() => props.onDelete(cfg.id)}
                    >
                        <Trash2 size={14} aria-hidden="true" />
                    </button>
                </div>
            </div>
            {errorMsg && <p className="mcp-server-error">{errorMsg}</p>}
            {tools.length > 0 && <p className="mcp-server-tools">{tools.join(", ")}</p>}
        </div>
    );
}
