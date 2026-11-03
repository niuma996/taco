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
import { IconButton } from "./ui/IconButton.tsx";

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
    // The strip stays mounted while empty so it can collapse out of the
    // footer instead of vanishing: the composer sits below it, and an
    // unmounted bar drops the whole input area by its own height in one
    // frame. The grid track carries the height change; the inner list
    // clips its overflow so the collapsed track can reach zero.
    return (
        <div className="ui-collapse" data-open={items.length > 0}>
            <ul className="queue-bar" aria-label={t("queue.title")} aria-live="polite">
                {items.map((item) => (
                    <li key={item.id} className="queue-bar__row">
                        <span className="queue-bar__kind">{t(KIND_LABEL_KEYS[item.kind])}</span>
                        <span className="queue-bar__text">{item.text}</span>
                        <IconButton
                            aria-label={t("queue.cancel")}
                            title={t("queue.cancel")}
                            disabled={item.optimistic === true}
                            onClick={() => onCancel(item)}
                        >
                            <X size={14} aria-hidden="true" />
                        </IconButton>
                    </li>
                ))}
            </ul>
        </div>
    );
}
