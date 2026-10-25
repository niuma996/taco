import type {
    MemoryDreamAction,
    MemoryDreamCounts,
    MemoryDreamReportSummary,
    MemoryDreamState,
} from "@taco-ai/protocol";
import type { DreamBusy } from "../../hooks/useMemoryPane";
import { useT, useUiLanguage } from "../../i18n/useI18n";
import { formatRelativeTime } from "../../lib/relativeTime";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";

export interface MemoryDreamActions {
    busy: DreamBusy | null;
    onRun: () => void | Promise<void>;
    onApply: (previewId: string) => void | Promise<void>;
    onDiscard: () => void | Promise<void>;
    onUndo: (reportId: string) => void | Promise<void>;
    onRestoreTopic: (id: string) => void | Promise<void>;
    onScheduleToggle: (enabled: boolean) => void | Promise<void>;
}

interface MemoryDreamPanelProps extends MemoryDreamActions {
    state?: MemoryDreamState;
    scheduled?: boolean;
}

function Counts({ counts }: { counts: MemoryDreamCounts }) {
    const { t } = useT();
    return (
        <span className="memory-dream-counts">
            {t("memory.dream.merged")} {counts.merged}→{counts.mergedInto} ·{" "}
            {t("memory.dream.archived")} {counts.archived} · {t("memory.dream.rewritten")}{" "}
            {counts.rewritten}
        </span>
    );
}

function ActionDetails({ action }: { action: MemoryDreamAction }) {
    const { t } = useT();
    if (action.action === "merge") {
        return (
            <details className="memory-dream-action">
                <summary>
                    {t("memory.dream.actionMerge")} {action.sourceIds.join(", ")} → {action.id}
                </summary>
                <div className="memory-dream-action-body">
                    <strong>{action.name}</strong>
                    <pre>{action.content}</pre>
                </div>
            </details>
        );
    }
    if (action.action === "rewrite") {
        return (
            <details className="memory-dream-action">
                <summary>
                    {t("memory.dream.actionRewrite")} {action.id}
                </summary>
                <pre className="memory-dream-action-body">{action.content}</pre>
            </details>
        );
    }
    return (
        <div className="memory-dream-action memory-dream-action-archive">
            <span>
                {t("memory.dream.actionArchive")} {action.id}: {action.reason}
            </span>
            {action.supersededBy ? (
                <small>
                    {t("memory.dream.supersededBy")} {action.supersededBy}
                </small>
            ) : null}
        </div>
    );
}

function PendingPreview({
    preview,
    busy,
    onApply,
    onDiscard,
}: {
    preview: NonNullable<MemoryDreamState["pending"]>;
    busy: DreamBusy | null;
    onApply: MemoryDreamActions["onApply"];
    onDiscard: MemoryDreamActions["onDiscard"];
}) {
    const { t } = useT();
    return (
        <section className="memory-dream-preview" aria-label={t("memory.dream.pendingTitle")}>
            <div className="memory-dream-section-heading">
                <strong>{t("memory.dream.pendingTitle")}</strong>
                <span>{t("memory.dream.pendingHint")}</span>
            </div>
            <Counts counts={preview.counts} />
            <div className="memory-dream-actions-list">
                {preview.actions.map((action, index) => (
                    <ActionDetails key={`${action.action}-${action.id}-${index}`} action={action} />
                ))}
            </div>
            <div className="memory-dream-preview-actions">
                <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => onApply(preview.id)}
                >
                    {busy === "apply" ? t("memory.dream.applying") : t("memory.dream.apply")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onDiscard}>
                    {t("memory.dream.discard")}
                </Button>
            </div>
        </section>
    );
}

function ReportHistory({
    reports,
    busy,
    onUndo,
}: {
    reports: readonly MemoryDreamReportSummary[];
    busy: DreamBusy | null;
    onUndo: MemoryDreamActions["onUndo"];
}) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = Date.now();
    return (
        <details className="memory-dream-history">
            <summary>
                {t("memory.dream.history")} ({reports.length})
            </summary>
            <ul>
                {reports.map((report) => (
                    <li key={report.id} className="memory-dream-report">
                        <div className="memory-dream-report-meta">
                            <span>
                                {formatRelativeTime(report.appliedAt, lng, nowMs)} ·{" "}
                                <Counts counts={report.counts} />
                            </span>
                            {report.skipped > 0 ? (
                                <small>
                                    {t("memory.dream.skipped")} {report.skipped}
                                </small>
                            ) : null}
                            {report.undoneAt ? (
                                <small>{t("memory.dream.undone")}</small>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy !== null}
                                    onClick={() => onUndo(report.id)}
                                >
                                    {busy === "undo"
                                        ? t("memory.dream.undoing")
                                        : t("memory.dream.undo")}
                                </Button>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </details>
    );
}

export function MemoryDreamPanel({
    state,
    scheduled,
    busy,
    onRun,
    onApply,
    onDiscard,
    onUndo,
    onScheduleToggle,
}: MemoryDreamPanelProps) {
    const { t } = useT();
    return (
        <section className="memory-dream-panel" aria-label={t("memory.dream.title")}>
            <div className="memory-dream-toolbar">
                <div className="memory-dream-schedule">
                    <Switch
                        label={t("memory.dream.schedule")}
                        checked={scheduled ?? false}
                        disabled={scheduled === undefined || busy !== null}
                        onChange={onScheduleToggle}
                    />
                    <span>{t("memory.dream.schedule")}</span>
                    {scheduled === undefined ? (
                        <small>{t("memory.dream.scheduleUnavailable")}</small>
                    ) : null}
                </div>
                <Button size="sm" variant="default" disabled={busy !== null} onClick={onRun}>
                    {busy === "run" ? t("memory.dream.running") : t("memory.dream.run")}
                </Button>
            </div>
            {state?.pending ? (
                <PendingPreview
                    preview={state.pending}
                    busy={busy}
                    onApply={onApply}
                    onDiscard={onDiscard}
                />
            ) : null}
            {state && state.reports.length > 0 ? (
                <ReportHistory reports={state.reports} busy={busy} onUndo={onUndo} />
            ) : null}
        </section>
    );
}
