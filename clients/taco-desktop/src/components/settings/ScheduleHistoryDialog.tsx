/**
 * ScheduleHistoryDialog — one job's recent runs.
 *
 * Two sources are joined here. `jobs.history` says how each fire went from the
 * scheduler's side: accepted, failed, or timed out waiting. For an
 * `agent.invoke` job, the entry also names the Work that tracked the turn,
 * and `work.list({ jobId })` says how that turn actually ended — which can be
 * later, and better, than a fire that timed out. The answer text is fetched
 * only when a row is opened.
 *
 * The dialog re-reads both on every `work.changed`, so a run that finishes
 * while it is open updates in place.
 */

import {
    type Job,
    type JobHistoryEntry,
    WORK_REASON_MERGED,
    type WorkSummary,
} from "@taco-ai/protocol";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { useState } from "react";
import { useJobHistory } from "../../hooks/useJobHistory";
import { useNow } from "../../hooks/useNow";
import { useWorkDetail } from "../../hooks/useWorkDetail";
import { useT, useUiLanguage } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { formatRelativeTime } from "../../lib/relativeTime";
import { IconButton } from "../ui/IconButton.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Tag } from "../ui/Tag.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";

export interface ScheduleHistoryDialogProps {
    client: TacoClient;
    /** The job whose runs to show; `null` keeps the dialog closed. */
    job: Job | null;
    onClose: () => void;
    /** Open the session a run happened in. */
    onOpenSession: (workspace: string, sessionId: string) => void;
}

/** What a row shows, after joining the history entry with its Work. */
export type RunState =
    | "waiting"
    | "running"
    | "completed"
    | "merged"
    | "failed"
    | "interrupted"
    | "cancelled"
    /** The fire stopped waiting, but its turn is still going. */
    | "timedOutRunning";

const RUN_TONE: Record<RunState, string> = {
    running: "work-status--muted",
    waiting: "work-status--warn",
    completed: "work-status--ok",
    merged: "work-status--muted",
    failed: "work-status--bad",
    interrupted: "work-status--bad",
    cancelled: "work-status--muted",
    timedOutRunning: "work-status--warn",
};

/**
 * The Work is the better witness when there is one: a fire that timed out
 * still has a turn that may complete, and an accepted fire may have failed.
 */
export function runState(entry: JobHistoryEntry, work: WorkSummary | undefined): RunState {
    if (work) {
        if (work.status === "running") {
            return entry.status === "err" ? "timedOutRunning" : "running";
        }
        if (work.status === "completed") {
            return work.reason === WORK_REASON_MERGED ? "merged" : "completed";
        }
        return work.status;
    }
    if (entry.status === "running") return "running";
    return entry.status === "ok" ? "completed" : "failed";
}

export function formatDreamFailureReason(
    reason: string | undefined,
    t: (key: string) => string,
): string {
    if (!reason) return t("schedules.history.unknownFailure");
    if (reason.includes("fire timeout"))
        return `${t("schedules.history.failure.fireTimeout")}: ${reason}`;
    if (reason.includes("model call timed out"))
        return `${t("schedules.history.failure.modelTimeout")}: ${reason}`;
    if (reason.includes("rejected plan") && reason.includes("does not exist"))
        return `${t("schedules.history.failure.invalidReference")}: ${reason}`;
    if (reason.includes("no parseable plan"))
        return `${t("schedules.history.failure.invalidOutput")}: ${reason}`;
    return reason;
}

/** Wall-clock length of a finished entry, or undefined while it runs. */
export function entryDurationMs(entry: JobHistoryEntry): number | undefined {
    if (!entry.ended_at) return undefined;
    const ms = Date.parse(entry.ended_at) - Date.parse(entry.started_at);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function ScheduleHistoryDialog({
    client,
    job,
    onClose,
    onOpenSession,
}: ScheduleHistoryDialogProps) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const jobId = job?.id;
    const { history, works, error } = useJobHistory(client, jobId);
    const [selection, setSelection] = useState({ jobId, workId: null as string | null });
    if (selection.jobId !== jobId) setSelection({ jobId, workId: null });
    const expanded = selection.jobId === jobId && jobId !== undefined ? selection.workId : null;
    const expandedRevision = expanded === null ? undefined : works.get(expanded)?.revision;
    const detail = useWorkDetail(client, expanded, expandedRevision);

    const renderEntry = (entry: JobHistoryEntry) => {
        const work = entry.workId !== undefined ? works.get(entry.workId) : undefined;
        const state = runState(entry, work);
        const duration = entryDurationMs(entry);
        const canExpand = work !== undefined;
        const isOpen = canExpand && expanded === work.workId;
        const shown = isOpen ? detail : undefined;
        const note =
            state === "timedOutRunning"
                ? t("schedules.history.timedOutRunning")
                : state === "merged"
                  ? t("schedules.history.mergedHint")
                  : state === "interrupted"
                    ? work?.reason
                    : formatDreamFailureReason(
                          entry.summary ?? (entry.status === "err" ? entry.error : undefined),
                          t,
                      );
        const sessionWorkspace = work?.workspace;
        const sessionId = work?.waiting?.sessionId ?? work?.sessionId;
        return (
            <li key={entry.started_at} className="work-item schedule-history-item">
                <div className="work-item-head">
                    <button
                        type="button"
                        className="work-item-toggle"
                        aria-expanded={canExpand ? isOpen : undefined}
                        disabled={!canExpand}
                        onClick={() =>
                            canExpand &&
                            setSelection({
                                jobId,
                                workId: expanded === work.workId ? null : work.workId,
                            })
                        }
                    >
                        {canExpand &&
                            (isOpen ? (
                                <ChevronDown size={14} aria-hidden="true" />
                            ) : (
                                <ChevronRight size={14} aria-hidden="true" />
                            ))}
                        <span className="work-item-title">
                            {formatRelativeTime(Date.parse(entry.started_at), lng, nowMs)}
                        </span>
                        <span className="work-item-agent">
                            {duration !== undefined ? formatDuration(duration) : ""}
                        </span>
                    </button>
                    {/* The note rides on the same line as the timestamp so
                        every collapsed run is the same height; the full
                        text is in the title and in the expanded row. The
                        slot is always there — a run with no note would
                        otherwise pull its status tag out of the column. */}
                    <span className="work-item-reason" title={note}>
                        {note}
                    </span>
                    {sessionWorkspace !== undefined && sessionId !== undefined ? (
                        <Tooltip label={t("work.openSession")} side="top">
                            <span className="schedules-history-session">
                                <IconButton
                                    size="sm"
                                    aria-label={t("work.openSession")}
                                    onClick={() => onOpenSession(sessionWorkspace, sessionId)}
                                >
                                    <MessageSquare size={13} aria-hidden="true" />
                                </IconButton>
                            </span>
                        </Tooltip>
                    ) : null}
                    <div className="work-item-badges">
                        {work?.completeness === "partial" && (
                            <Tag size="sm" className="work-status--warn">
                                {t("work.partial")}
                            </Tag>
                        )}
                        <Tag size="sm" className={RUN_TONE[state]}>
                            {t(`schedules.history.state.${state}`)}
                        </Tag>
                    </div>
                </div>

                {isOpen && (
                    <div className="work-item-detail">
                        {shown === undefined ? (
                            <p className="work-item-summary">{t("work.resultLoading")}</p>
                        ) : shown.resultText ? (
                            <>
                                <pre className="work-result-text">{shown.resultText}</pre>
                                {shown.resultTruncated && (
                                    <p className="work-item-summary">{t("work.resultTruncated")}</p>
                                )}
                            </>
                        ) : (
                            <p className="work-item-summary">
                                {work.status === "running" || work.status === "waiting"
                                    ? t("work.resultPending")
                                    : work.reason === WORK_REASON_MERGED
                                      ? t("schedules.history.mergedHint")
                                      : t("work.resultGone")}
                            </p>
                        )}
                    </div>
                )}
            </li>
        );
    };

    return (
        <Modal
            open={job !== null}
            onClose={onClose}
            title={t("schedules.history.title", { name: job?.name ?? "" })}
            className="schedule-history-modal"
        >
            {error ? (
                <p className="schedules-error" role="alert">
                    {error}
                </p>
            ) : history === null ? (
                <p className="work-item-summary">{t("schedules.history.loading")}</p>
            ) : history.length === 0 ? (
                <p className="work-item-summary">{t("schedules.history.empty")}</p>
            ) : (
                <ul className="work-list">{history.map(renderEntry)}</ul>
            )}
        </Modal>
    );
}
