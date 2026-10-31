/**
 * NotificationBell — topbar bell that collects what used to be the full-width
 * error banner: sidecar `[error]` lines, failed RPCs, model/level change
 * failures. Nothing takes over the topbar row any more; the bell just marks
 * itself unread and the user opens the list when they want to read it.
 *
 * Unread is presentation, so it lives here rather than in the store. Ids are
 * allocated monotonically by the store, so "unread" is simply every row whose
 * id is above the newest one the user has had on screen: opening the popover
 * reads everything in it, rows arriving while it is open are read on arrival,
 * and dismissing or clearing rows can never resurrect an older one as new.
 * Coalesced repeats keep their id, so a repeating error stays one unread row.
 *
 * `onNewArrival` hands each genuinely new row to App, which decides — via
 * `toastsOnArrival` — whether it also deserves a toast. Rows that do not get
 * one are announced through this component's own live region instead, so a
 * screen-reader user hears every arrival exactly once.
 */

import { Bell, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../hooks/useNow.ts";
import { useT, useUiLanguage } from "../i18n/useI18n.ts";
import {
    type AppNotification,
    type ApprovalNotificationTarget,
    toastsOnArrival,
} from "../lib/notifications.ts";
import { formatRelativeTime } from "../lib/relativeTime.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { BAR_ICON } from "./ui/iconSize.ts";
import { PopoverPanel } from "./ui/PopoverPanel.tsx";

export interface NotificationBellProps {
    notifications: AppNotification[];
    onOpenApproval?: (target: ApprovalNotificationTarget) => void;
    onDismiss: (id: number) => void;
    onClearAll: () => void;
    /**
     * Fires once per row that arrives while the popover is closed, oldest first.
     * Never fires for a coalesced repeat, nor for rows already in the list when
     * the bell mounted. Omitted in tests and wherever a toast is not wanted.
     */
    onNewArrival?: (notification: AppNotification) => void;
}

export function NotificationBell({
    notifications,
    onDismiss,
    onClearAll,
    onNewArrival,
    onOpenApproval,
}: NotificationBellProps) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const [open, setOpen] = useState(false);
    // Highest id the user has had on screen (popover open). Rows above it are
    // unread. Starts at 0 so a list populated before mount still badges — the
    // user has never seen it.
    const [readId, setReadId] = useState(0);
    // Highest id already handed to `onNewArrival`. Separate from `readId`:
    // rows already present at mount are unread but must not be re-reported as
    // fresh arrivals, and a row that arrives while the popover is open is both
    // read and reported-as-handled at once.
    const reportedIdRef = useRef(notifications[0]?.id ?? 0);
    // Text of the last arrival that will not get a toast, mirrored into a live
    // region. Toasted rows are skipped here: the toast's `role="alert"` already
    // announces them.
    const [announcement, setAnnouncement] = useState("");

    useEffect(() => {
        const newestId = notifications[0]?.id ?? 0;
        if (open) {
            if (newestId > readId) setReadId(newestId);
            reportedIdRef.current = Math.max(reportedIdRef.current, newestId);
            return;
        }
        const reported = reportedIdRef.current;
        if (newestId <= reported) return;
        reportedIdRef.current = newestId;
        // Newest-first list → walk backwards so arrivals are reported in order.
        const arrivals = notifications.filter((n) => n.id > reported).reverse();
        for (const n of arrivals) onNewArrival?.(n);
        const silent = arrivals.filter((n) => !toastsOnArrival(n)).at(-1);
        if (silent) setAnnouncement(silent.text);
    }, [open, notifications, readId, onNewArrival]);

    const unread = notifications.filter((n) => n.id > readId).length;

    const unreadLabel = unread > 0 ? t("app.notificationsUnread", { count: unread }) : "";

    return (
        <>
            <PopoverPanel
                open={open}
                onOpenChange={setOpen}
                title={t("app.notifications")}
                action={
                    notifications.length > 0 && (
                        <button
                            type="button"
                            className="ui-popover-panel__action"
                            onClick={onClearAll}
                        >
                            {t("app.notificationsClearAll")}
                        </button>
                    )
                }
                trigger={
                    <IconButton
                        size="lg"
                        aria-label={
                            unreadLabel
                                ? `${t("app.notifications")} — ${unreadLabel}`
                                : t("app.notifications")
                        }
                    >
                        <span className="notification-bell__icon">
                            <Bell {...BAR_ICON} />
                            {unread > 0 && (
                                <span className="notification-bell__badge" aria-hidden="true">
                                    {unread > 99 ? "99+" : unread}
                                </span>
                            )}
                        </span>
                    </IconButton>
                }
            >
                {notifications.length === 0 ? (
                    <div className="ui-popover-panel__empty">{t("app.notificationsEmpty")}</div>
                ) : (
                    <ul className="notification-popover__list">
                        {notifications.map((n) => (
                            <li key={n.id} className="notification-row" data-level={n.level}>
                                <span className="notification-row__time">
                                    {formatRelativeTime(n.at, lng, nowMs)}
                                </span>
                                <span className="notification-row__text">{n.text}</span>
                                {n.approval && onOpenApproval && (
                                    <button
                                        type="button"
                                        className="ui-popover-panel__action"
                                        onClick={() => {
                                            if (n.approval) onOpenApproval(n.approval);
                                            setOpen(false);
                                        }}
                                    >
                                        {t("session.openApproval")}
                                    </button>
                                )}
                                {n.count > 1 && (
                                    <span
                                        className="notification-row__count"
                                        title={t("app.notificationsRepeated", {
                                            count: n.count,
                                        })}
                                    >
                                        ×{n.count}
                                    </span>
                                )}
                                <IconButton
                                    size="sm"
                                    aria-label={t("app.dismiss")}
                                    onClick={() => onDismiss(n.id)}
                                >
                                    <X size={12} aria-hidden="true" />
                                </IconButton>
                            </li>
                        ))}
                    </ul>
                )}
            </PopoverPanel>
            {/* The badge is aria-hidden decoration, and Radix unmounts the
                popover content while it is closed — so the live region has to
                live here, always mounted, or a failure arriving at a closed
                bell is announced to nobody. */}
            <span className="sr-only" role="status" aria-live="polite">
                {announcement}
            </span>
        </>
    );
}
