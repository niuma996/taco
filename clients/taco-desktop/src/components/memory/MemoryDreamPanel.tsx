/**
 * MemoryDreamPanel — the consolidation view that owns the memory pane's right
 * column while it is open.
 *
 * Workspace-level controls (schedule switch, manual run, preview, history) live
 * here rather than above the reading view: they act on the whole memory set,
 * not on whichever entry happened to be selected.
 */

import type {
    MemoryDreamAction,
    MemoryDreamCounts,
    MemoryDreamReportSummary,
    MemoryDreamState,
    MemoryTopicEntry,
} from "@taco-ai/protocol";
import { X } from "lucide-react";
import type { DreamBusy } from "../../hooks/useMemoryPane";
import { useNow } from "../../hooks/useNow";
import { useT, useUiLanguage } from "../../i18n/useI18n";
import { formatRelativeTime } from "../../lib/relativeTime";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Switch } from "../ui/Switch";

/** Dream actions; a `false` result means it failed and was already notified. */
export interface MemoryDreamActions {
    busy: DreamBusy | null;
    onRun: () => unknown;
    onApply: (previewId: string) => unknown;
    onDiscard: () => unknown;
    onUndo: (reportId: string) => unknown;
    onRestoreTopic: (id: string) => boolean | Promise<boolean>;
    onScheduleToggle: (enabled: boolean) => unknown;
}

interface MemoryDreamPanelProps extends Omit<MemoryDreamActions, "onRestoreTopic"> {
    state?: MemoryDreamState;
    scheduled?: boolean;
    /** Why the scheduler switched the job off by itself; shown as a warning. */
    pausedReason?: string;
    /** Live topics, so plan actions can name the entries they touch. */
    topics?: readonly MemoryTopicEntry[];
    onClose: () => void;
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

function buildTopicNames(topics: readonly MemoryTopicEntry[]) {
    return new Map(topics.map((topic) => [topic.id, topic.name]));
}

function topicLabel(id: string, names: ReadonlyMap<string, string>): string {
    return names.get(id) ?? id;
}

function ActionDetails({
    action,
    names,
}: {
    action: MemoryDreamAction;
    names: ReadonlyMap<string, string>;
}) {
    const { t } = useT();
    if (action.action === "merge") {
        return (
            <details className="memory-dream-action">
                <summary>
                    {action.sourceIds.map((sourceId) => topicLabel(sourceId, names)).join(" + ")} →{" "}
                    {action.name}
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
                <summary>{topicLabel(action.id, names)}</summary>
                <pre className="memory-dream-action-body">{action.content}</pre>
            </details>
        );
    }
    return (
        <div className="memory-dream-action memory-dream-action-archive">
            <span>
                {topicLabel(action.id, names)}: {action.reason}
            </span>
            {action.supersededBy ? (
                <small>
                    {t("memory.dream.supersededBy")} {topicLabel(action.supersededBy, names)}
                </small>
            ) : null}
        </div>
    );
}

function ActionGroup({
    label,
    actions,
    names,
}: {
    label: string;
    actions: readonly MemoryDreamAction[];
    names: ReadonlyMap<string, string>;
}) {
    if (actions.length === 0) return null;
    return (
        <div className="memory-dream-group">
            <div className="memory-dream-group-label">
                {label} ({actions.length})
            </div>
            {actions.map((action, index) => (
                <ActionDetails
                    key={`${action.action}-${action.id}-${index}`}
                    action={action}
                    names={names}
                />
            ))}
        </div>
    );
}

function PendingPreview({
    preview,
    names,
    busy,
    onApply,
    onDiscard,
}: {
    preview: NonNullable<MemoryDreamState["pending"]>;
    names: ReadonlyMap<string, string>;
    busy: DreamBusy | null;
    onApply: MemoryDreamActions["onApply"];
    onDiscard: MemoryDreamActions["onDiscard"];
}) {
    const { t } = useT();
    const merges = preview.actions.filter((action) => action.action === "merge");
    const rewrites = preview.actions.filter((action) => action.action === "rewrite");
    const archives = preview.actions.filter((action) => action.action === "archive");
    return (
        <section className="memory-dream-preview" aria-label={t("memory.dream.pendingTitle")}>
            <div className="memory-dream-section-heading">
                <strong>{t("memory.dream.pendingTitle")}</strong>
                <span>{t("memory.dream.pendingHint")}</span>
            </div>
            <Counts counts={preview.counts} />
            <div className="memory-dream-actions-list">
                <ActionGroup label={t("memory.dream.actionMerge")} actions={merges} names={names} />
                <ActionGroup
                    label={t("memory.dream.actionRewrite")}
                    actions={rewrites}
                    names={names}
                />
                <ActionGroup
                    label={t("memory.dream.actionArchive")}
                    actions={archives}
                    names={names}
                />
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
    const nowMs = useNow();
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
    pausedReason,
    topics = [],
    busy,
    onRun,
    onApply,
    onDiscard,
    onUndo,
    onScheduleToggle,
    onClose,
}: MemoryDreamPanelProps) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const names = buildTopicNames(topics);

    return (
        <section className="memory-dream-view" aria-label={t("memory.dream.title")}>
            <div className="memory-dream-header">
                <div>
                    <h2>{t("memory.dream.title")}</h2>
                    <p className="memory-dream-subtitle">
                        {state?.lastRunAt
                            ? `${t("memory.dream.lastRun")} ${formatRelativeTime(
                                  state.lastRunAt,
                                  lng,
                                  nowMs,
                              )}`
                            : t("memory.dream.neverRun")}
                    </p>
                </div>
                <IconButton aria-label={t("memory.dream.close")} onClick={onClose}>
                    <X size={14} aria-hidden="true" />
                </IconButton>
            </div>

            <div className="memory-dream-toolbar">
                <div className="memory-dream-schedule">
                    <Switch
                        label={t("memory.dream.schedule")}
                        checked={scheduled ?? false}
                        disabled={scheduled === undefined || busy !== null}
                        onChange={onScheduleToggle}
                    />
                    <span>{t("memory.dream.schedule")}</span>
                </div>
                <Button size="sm" variant="default" disabled={busy !== null} onClick={onRun}>
                    {busy === "run" ? t("memory.dream.running") : t("memory.dream.run")}
                </Button>
            </div>
            {pausedReason ? (
                // Turned off by the failure breaker, not by the user: the
                // switch alone would look like a choice they made.
                <p className="memory-dream-note memory-dream-note-warning" role="status">
                    {t("memory.dream.pausedReason")}: {pausedReason}
                </p>
            ) : null}
            <p className="memory-dream-note">
                {scheduled === undefined
                    ? t("memory.dream.scheduleUnavailable")
                    : t("memory.dream.scheduleNote")}
            </p>

            {state?.pending ? (
                <PendingPreview
                    preview={state.pending}
                    names={names}
                    busy={busy}
                    onApply={onApply}
                    onDiscard={onDiscard}
                />
            ) : (
                <p className="memory-dream-idle">{t("memory.dream.idle")}</p>
            )}

            {state && state.reports.length > 0 ? (
                <ReportHistory reports={state.reports} busy={busy} onUndo={onUndo} />
            ) : null}
        </section>
    );
}
