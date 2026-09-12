/**
 * QueueBar — steering-queue strip above the composer.
 *
 * Lists the active session's not-yet-consumed steer / followUp / nextRun
 * entries (WorkspaceState.queuedBySessionId, fed by the server's queue_update
 * push). Server-acked rows carry an entryId and can be cancelled individually;
 * optimistic rows (appended locally before the queue_update ack) keep their
 * cancel button disabled for the brief window until the ack replaces them.
 */

import { X } from "lucide-react";
import { useT } from "../i18n/useI18n.ts";
import type { QueuedUiItem } from "../lib/chat/chatUtils";

export interface QueueBarProps {
    items: QueuedUiItem[];
    /** Cancel one queued row. Only fired for server-acked rows. */
    onCancel: (item: QueuedUiItem) => void;
}

const KIND_LABEL_KEYS: Record<QueuedUiItem["kind"], string> = {
    steer: "queue.kindSteer",
    followUp: "queue.kindFollowUp",
    nextRun: "queue.kindNextRun",
};

export function QueueBar({ items, onCancel }: QueueBarProps) {
    const { t } = useT();
    if (items.length === 0) return null;
    return (
        <ul className="queue-bar" aria-label={t("queue.title")} aria-live="polite">
            {items.map((item) => (
                <li key={item.id} className="queue-bar__row">
                    <span className="queue-bar__kind">{t(KIND_LABEL_KEYS[item.kind])}</span>
                    <span className="queue-bar__text">{item.text}</span>
                    <button
                        type="button"
                        className="queue-bar__cancel"
                        aria-label={t("queue.cancel")}
                        title={t("queue.cancel")}
                        disabled={item.optimistic === true}
                        onClick={() => onCancel(item)}
                    >
                        <X size={14} aria-hidden="true" />
                    </button>
                </li>
            ))}
        </ul>
    );
}
