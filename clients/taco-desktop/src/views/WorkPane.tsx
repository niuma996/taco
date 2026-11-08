/**
 * WorkPane — the overview and controls for managed background work.
 *
 * Every row is one Work the daemon tracks: a background subagent launch, or one
 * fire of a scheduled job.
 * Rows are grouped into what is running, what needs the user (a notice that
 * could not be delivered, a run a crash cut short) and what is finished. The
 * answer text is fetched only when a row is opened.
 *
 * Controls use the displayed attempt identity and the daemon's method capabilities.
 */

import type { SessionTarget } from "@taco-ai/protocol";
import {
    WORK_RETRYABLE_DELIVERY_STATUSES,
    type WorkDeliverySummary,
    type WorkGetResult,
    type WorkSummary,
} from "@taco-ai/protocol";
import {
    ChevronDown,
    ChevronRight,
    ClipboardList,
    MessageSquare,
    RefreshCw,
    Square,
    Trash2,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Tag } from "../components/ui/Tag";
import { useAutoClearError } from "../hooks/primitives/useAutoClearError";
import { useNow } from "../hooks/useNow";
import type { UseWorkOverviewResult } from "../hooks/useWorkOverview";
import { useT, useUiLanguage } from "../i18n/useI18n";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { formatRelativeTime } from "../lib/relativeTime";
import type { WorkGroupId } from "../lib/workOverview";

export interface WorkPaneProps {
    client: TacoClient;
    overview: UseWorkOverviewResult;
    /** Jump to the conversation that started a Work. */
    onOpenSession: (target: SessionTarget) => void;
}

const STATUS_TONE: Record<WorkSummary["status"], { tone?: "strong"; className?: string }> = {
    running: {},
    waiting: { className: "work-status--warn", tone: "strong" },
    completed: { className: "work-status--ok" },
    failed: { className: "work-status--bad" },
    cancelled: { className: "work-status--muted" },
    interrupted: { className: "work-status--bad", tone: "strong" },
};

function deliveryTone(delivery: WorkDeliverySummary): string {
    switch (delivery.status) {
        case "confirmed":
            return "work-status--ok";
        case "retryExhausted":
        case "expired":
        case "permanentFailure":
            return "work-status--bad";
        default:
            return "work-status--muted";
    }
}

function retryable(delivery: WorkDeliverySummary | undefined): boolean {
    return (
        delivery !== undefined &&
        (WORK_RETRYABLE_DELIVERY_STATUSES as readonly string[]).includes(delivery.status)
    );
}

export function WorkPane({ client, overview, onOpenSession }: WorkPaneProps) {
    const { state, loading, loadingMore, error, retryingId, refresh, loadMore, retryDelivery } =
        overview;
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const listRef = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [expandedDetail, setExpandedDetail] = useState<
        { workId: string; result: WorkGetResult } | undefined
    >(undefined);
    const pendingRef = useRef(new Set<string>());
    const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
    const { error: actionError, fail, clearError } = useAutoClearError();
    const [, capabilitiesChanged] = useState(0);
    useEffect(
        () => client.onConnectionReady?.(() => capabilitiesChanged((value) => value + 1)),
        [client],
    );
    const methods = client.getServerCapabilities?.()?.methods ?? [];
    const runAction = async (work: WorkSummary, action: "cancel" | "delete"): Promise<void> => {
        if (pendingRef.current.has(work.workId) || !methods.includes(`work.${action}`)) return;
        if (action === "cancel" && !work.attemptId) return;
        pendingRef.current.add(work.workId);
        setPendingIds(new Set(pendingRef.current));
        clearError();
        try {
            const result =
                action === "cancel"
                    ? await client.workCancel({
                          workId: work.workId,
                          attemptId: work.attemptId as string,
                      })
                    : await client.workDelete({ workId: work.workId });
            if (result.outcome !== "accepted" && result.outcome !== "deleted") {
                fail(new Error(t(`work.actionOutcome.${result.outcome}`)));
            }
        } catch {
            fail(new Error(t("work.actionFailed")));
        } finally {
            pendingRef.current.delete(work.workId);
            setPendingIds(new Set(pendingRef.current));
            refresh();
        }
    };
    const expandedWork =
        expanded === null
            ? undefined
            : [...state.groups.running, ...state.groups.attention, ...state.groups.finished].find(
                  (work) => work.workId === expanded,
              );

    const expandedRevision = expandedWork?.revision;
    useEffect(() => {
        if (expanded === null || expandedRevision === undefined) {
            setExpandedDetail(undefined);
            return;
        }
        let stale = false;
        setExpandedDetail(undefined);
        // Revision is in the key: a running Work's first answer has no result
        // yet, and must not remain cached after the run settles.
        void client
            .workGet({ workId: expanded })
            .then((result) => {
                if (!stale) setExpandedDetail({ workId: expanded, result });
            })
            .catch(() => {
                if (!stale) setExpandedDetail({ workId: expanded, result: { work: null } });
            });
        return () => {
            stale = true;
        };
    }, [client, expanded, expandedRevision]);

    const toggle = (workId: string): void => {
        setExpanded((current) => (current === workId ? null : workId));
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const rows = Array.from(
            listRef.current?.querySelectorAll<HTMLButtonElement>("[data-work-row]") ?? [],
        );
        if (rows.length === 0) return;
        event.preventDefault();
        const current = rows.indexOf(document.activeElement as HTMLButtonElement);
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : Math.min(
                        rows.length - 1,
                        Math.max(
                            0,
                            (current < 0 ? -1 : current) + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                    );
        rows[index]?.focus();
    };

    const renderRow = (work: WorkSummary) => {
        const target: SessionTarget | undefined =
            work.workspace && (work.sessionState === undefined || work.sessionState === "available")
                ? {
                      workspace: work.workspace,
                      sessionId: work.waiting?.sessionId ?? work.sessionId,
                  }
                : undefined;
        const isOpen = expanded === work.workId;
        const knownStatus = Object.hasOwn(STATUS_TONE, work.status);
        const status = knownStatus ? STATUS_TONE[work.status] : {};
        const cancellable =
            (work.status === "running" || work.status === "waiting") &&
            work.canCancel === true &&
            !!work.attemptId;
        const deletable =
            work.attemptId !== undefined &&
            ["completed", "failed", "cancelled", "interrupted"].includes(work.status);
        const waitingDescription =
            work.waiting?.toolName === "permission"
                ? t("work.permissionRequired")
                : work.waiting?.description;
        const detail = expandedDetail?.workId === work.workId ? expandedDetail.result : undefined;
        return (
            <li
                key={work.workId}
                className="work-item"
                data-attention={String(work.needsAttention)}
            >
                <div className="work-item-head">
                    <button
                        type="button"
                        className="work-item-toggle"
                        data-work-row={work.workId}
                        aria-expanded={isOpen}
                        onClick={() => toggle(work.workId)}
                    >
                        {isOpen ? (
                            <ChevronDown size={14} aria-hidden="true" />
                        ) : (
                            <ChevronRight size={14} aria-hidden="true" />
                        )}
                        <span className="work-item-title">{work.title || work.agentType}</span>
                        <span className="work-item-agent">
                            {work.kind === "scheduled" ? t("work.kind.scheduled") : work.agentType}
                        </span>
                    </button>
                    <div className="work-item-badges">
                        {work.completeness === "partial" && (
                            <Tag size="sm" className="work-status--warn">
                                {t("work.partial")}
                            </Tag>
                        )}
                        {work.delivery && (
                            <Tag
                                size="sm"
                                className={deliveryTone(work.delivery)}
                                title={work.delivery.lastError}
                            >
                                {t(`work.delivery.${work.delivery.status}`)}
                            </Tag>
                        )}
                        <Tag size="sm" className={status.className} tone={status.tone}>
                            {t(`work.status.${knownStatus ? work.status : "unknown"}`)}
                        </Tag>
                    </div>
                </div>

                <div className="work-item-meta">
                    <span>{formatRelativeTime(work.endedAt ?? work.createdAt, lng, nowMs)}</span>
                    {work.reason && <span className="work-item-reason">{work.reason}</span>}
                </div>

                {waitingDescription && (
                    <p className="work-item-waiting">
                        {waitingDescription.length > 240
                            ? `${waitingDescription.slice(0, 239)}…`
                            : waitingDescription}
                    </p>
                )}

                <div className="work-item-actions">
                    <button
                        type="button"
                        className="work-action"
                        disabled={target === undefined}
                        title={
                            target === undefined
                                ? t(
                                      work.sessionState === "deleted"
                                          ? "work.openSessionDeleted"
                                          : "work.openSessionUnavailable",
                                  )
                                : t("work.openSession")
                        }
                        onClick={() => {
                            if (target) onOpenSession(target);
                        }}
                    >
                        <MessageSquare size={13} aria-hidden="true" />
                        {t("work.openSession")}
                    </button>
                    {cancellable && (
                        <button
                            type="button"
                            className="work-action"
                            disabled={
                                pendingIds.has(work.workId) || !methods.includes("work.cancel")
                            }
                            title={
                                !methods.includes("work.cancel")
                                    ? t("work.actionUnsupported")
                                    : t("work.cancel")
                            }
                            onClick={() => void runAction(work, "cancel")}
                        >
                            <Square size={13} aria-hidden="true" />
                            {t("work.cancel")}
                        </button>
                    )}
                    {deletable && (
                        <button
                            type="button"
                            className="work-action"
                            disabled={
                                pendingIds.has(work.workId) || !methods.includes("work.delete")
                            }
                            title={
                                !methods.includes("work.delete")
                                    ? t("work.actionUnsupported")
                                    : t("work.delete")
                            }
                            onClick={() => void runAction(work, "delete")}
                        >
                            <Trash2 size={13} aria-hidden="true" />
                            {t("work.delete")}
                        </button>
                    )}
                    {retryable(work.delivery) && (
                        <button
                            type="button"
                            className="work-action work-action--accent"
                            disabled={retryingId === work.workId}
                            onClick={() => void retryDelivery(work.workId)}
                        >
                            <RefreshCw size={13} aria-hidden="true" />
                            {t("work.retryDelivery")}
                        </button>
                    )}
                </div>

                {isOpen && (
                    <div className="work-item-detail">
                        {work.summary && <p className="work-item-summary">{work.summary}</p>}
                        {detail?.resultText ? (
                            <pre className="work-result-text">{detail.resultText}</pre>
                        ) : (
                            <p className="work-detail-hint">
                                {detail === undefined
                                    ? t("work.resultLoading")
                                    : work.status === "running" || work.status === "waiting"
                                      ? t("work.resultPending")
                                      : t("work.resultGone")}
                            </p>
                        )}
                        {detail?.resultTruncated && (
                            <p className="work-detail-hint">{t("work.resultTruncated")}</p>
                        )}
                    </div>
                )}
            </li>
        );
    };

    const groups: { id: WorkGroupId; rows: WorkSummary[] }[] = [
        { id: "running", rows: state.groups.running },
        { id: "attention", rows: state.groups.attention },
        { id: "finished", rows: state.groups.finished },
    ];

    if (!state.loaded) {
        if (error) {
            return (
                <div className="pane-error" role="alert">
                    {error}
                </div>
            );
        }
        return <div className="pane-empty">{t("work.loading")}</div>;
    }

    const total = groups.reduce((n, g) => n + g.rows.length, 0);

    return (
        <div className="work-pane">
            <div className="pane-header">
                <div className="pane-header-title">
                    <ClipboardList size={16} aria-hidden="true" />
                    {t("work.title")}
                </div>
                <IconButton
                    onClick={refresh}
                    disabled={loading}
                    title={t("work.refresh")}
                    aria-label={t("work.refresh")}
                >
                    <RefreshCw size={14} aria-hidden="true" />
                </IconButton>
            </div>

            {error && (
                <div className="pane-error" role="alert">
                    {error}
                </div>
            )}
            {actionError && (
                <div className="pane-error" role="alert">
                    {actionError}
                </div>
            )}

            {total === 0 ? (
                <div className="work-empty">
                    <p>{t("work.empty")}</p>
                    <p className="hint">{t("work.emptyHint")}</p>
                </div>
            ) : (
                <div className="work-groups" ref={listRef} onKeyDown={handleKeyDown}>
                    {groups.map((group) =>
                        group.rows.length === 0 ? null : (
                            <section key={group.id} className="work-group">
                                <h3 className="work-group-title">
                                    {t(`work.group.${group.id}`)}
                                    <span className="work-group-count">{group.rows.length}</span>
                                </h3>
                                <ul className="work-list">{group.rows.map(renderRow)}</ul>
                            </section>
                        ),
                    )}
                    {state.nextCursor !== undefined && (
                        <div className="work-more">
                            <button
                                type="button"
                                className="work-action"
                                disabled={loadingMore}
                                onClick={loadMore}
                            >
                                {loadingMore ? t("work.loadingMore") : t("work.loadMore")}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
