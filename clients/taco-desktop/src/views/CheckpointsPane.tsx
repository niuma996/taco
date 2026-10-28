/**
 * CheckpointsPane — restore-point list and restore action.
 *
 * Rendered when `mainView === "checkpoints"`. The pane is purely view; the
 * sidecar fetch + restore live in useCheckpointsPane. Restore must be
 * confirmed: it is destructive, even with the auto-protection snapshot.
 *
 * Sessions must be active for restore — otherwise the protection snapshot
 * would land in a phantom session. The hook passes the current session id
 * through and the pane disables the action when it is missing.
 */

import type { CheckpointEntry } from "@taco-ai/protocol";
import { RefreshCw, RotateCcwClock } from "lucide-react";
import { useState } from "react";
import { ConfirmModal } from "../components/ConfirmModal";
import { IconButton } from "../components/ui/IconButton";
import type { UseCheckpointsPaneResult } from "../hooks/useCheckpointsPane";
import { useNow } from "../hooks/useNow";
import { useT, useUiLanguage } from "../i18n/useI18n";
import { formatRelativeTime } from "../lib/relativeTime";
import { lastSegment } from "../lib/workspaceStorage";

export interface CheckpointsPaneProps extends UseCheckpointsPaneResult {
    hasActiveSession: boolean;
}

export function CheckpointsPane(props: CheckpointsPaneProps) {
    const { data, loading, error, restoringId, refresh, restore, hasActiveSession } = props;
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const [pendingRestore, setPendingRestore] = useState<CheckpointEntry | null>(null);

    if (!data) {
        if (error)
            return (
                <div className="pane-error" role="alert">
                    {error}
                </div>
            );
        return <div className="pane-empty">{t("checkpoints.loading")}</div>;
    }

    if (!data.enabled) {
        return <div className="pane-empty">{t("checkpoints.disabled")}</div>;
    }

    return (
        <div className="checkpoints-pane">
            <div className="pane-header">
                <div className="pane-header-title">
                    <RotateCcwClock size={16} aria-hidden="true" />
                    {t("checkpoints.title")}
                </div>
                <IconButton
                    onClick={refresh}
                    disabled={loading}
                    title={t("checkpoints.refresh")}
                    aria-label={t("checkpoints.refresh")}
                >
                    <RefreshCw size={14} aria-hidden="true" />
                </IconButton>
            </div>

            {data.checkpoints.length === 0 ? (
                <div className="checkpoints-empty">
                    <p>{t("checkpoints.empty")}</p>
                    <p className="hint">{t("checkpoints.emptyHint")}</p>
                </div>
            ) : (
                <ul className="checkpoints-list" aria-busy={loading}>
                    {data.checkpoints.map((c) => {
                        const isRestoring = restoringId === c.id;
                        const disabled = isRestoring || !hasActiveSession;
                        return (
                            <li key={c.id} className="checkpoint-item">
                                <div className="checkpoint-meta">
                                    <span className="checkpoint-time">
                                        {formatRelativeTime(c.createdAt, lng, nowMs) ||
                                            t("checkpoints.unknownTime")}
                                    </span>
                                    <span className="checkpoint-label">{c.label}</span>
                                </div>
                                <div
                                    className="checkpoint-files"
                                    title={c.files.map((f) => f.path).join("\n")}
                                >
                                    {c.files
                                        .slice(0, 3)
                                        .map((f) => lastSegment(f.path))
                                        .join(", ")}
                                    {c.files.length > 3 ? ` +${c.files.length - 3}` : ""}
                                </div>
                                <button
                                    type="button"
                                    className="checkpoint-restore"
                                    onClick={() => setPendingRestore(c)}
                                    disabled={disabled}
                                    aria-disabled={disabled || undefined}
                                    aria-describedby={
                                        !hasActiveSession ? `cp-hint-${c.id}` : undefined
                                    }
                                    title={
                                        hasActiveSession
                                            ? t("checkpoints.restore")
                                            : t("checkpoints.restoreNeedsSession")
                                    }
                                >
                                    {isRestoring
                                        ? t("checkpoints.restoring")
                                        : t("checkpoints.restore")}
                                </button>
                                {!hasActiveSession && (
                                    <span
                                        id={`cp-hint-${c.id}`}
                                        className="checkpoint-restore-hint"
                                    >
                                        {t("checkpoints.restoreNeedsSession")}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            <ConfirmModal
                open={pendingRestore !== null}
                title={t("checkpoints.confirmTitle")}
                message={
                    pendingRestore
                        ? t("checkpoints.confirmMessage", {
                              label: pendingRestore.label,
                              count: pendingRestore.files.length,
                          })
                        : ""
                }
                confirmLabel={t("checkpoints.confirmRestore")}
                cancelLabel={t("checkpoints.confirmCancel")}
                onConfirm={() => {
                    const target = pendingRestore;
                    setPendingRestore(null);
                    if (!target) return;
                    void restore(target.id);
                }}
                onCancel={() => setPendingRestore(null)}
            />
        </div>
    );
}
