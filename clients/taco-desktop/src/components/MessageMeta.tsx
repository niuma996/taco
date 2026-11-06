/**
 * MessageMeta — timestamp + copy button for a message bubble's footer.
 *
 * Rendered only for messages that close a turn (`isLastInTurn && !isTurnInProgress`
 * in the caller), so the row never appears mid-stream or in the middle of a
 * chain of assistant messages. The caller already filtered; this component just
 * owns the layout.
 *
 * `text` is what the copy button ships to the clipboard — the message's raw
 * markdown source for assistant rows, plain text for user rows. The two have
 * different shapes (`m.text` on both, but user messages never have markdown
 * rendering attached) so callers pass through whatever they have on the
 * original UiMessage.
 */

import type { CheckpointEntry } from "@taco-ai/protocol";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useNow } from "../hooks/useNow";
import { useT, useUiLanguage } from "../i18n/useI18n";
import { formatRelativeTime } from "../lib/relativeTime";
import { ConfirmModal } from "./ConfirmModal";
import { CopyButton } from "./ui/CopyButton";

export interface MessageMetaProps {
    /** Epoch ms for the row's timestamp. */
    ts: number;
    /** Text shipped to the clipboard on copy. */
    text: string;
    checkpoint?: CheckpointEntry;
    onRestoreCheckpoint?: (
        checkpointId: string,
    ) => Promise<{ ok: true; protectionId?: string } | { ok: false; reason: string }>;
}

export function MessageMeta({ ts, text, checkpoint, onRestoreCheckpoint }: MessageMetaProps) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const canRestore = Boolean(checkpoint && onRestoreCheckpoint && checkpoint.files.length > 0);
    return (
        <>
            <div className="message-meta">
                <time className="message-meta__time" dateTime={new Date(ts).toISOString()}>
                    {formatRelativeTime(ts, lng, nowMs)}
                </time>
                <CopyButton
                    value={text}
                    className="message-meta__copy"
                    labels={{
                        idle: t("message.copy"),
                        copied: t("message.copied"),
                        failed: t("message.copyFailed"),
                    }}
                />
                {canRestore && checkpoint && onRestoreCheckpoint && (
                    <button
                        type="button"
                        className="message-meta__checkpoint"
                        disabled={busy}
                        onClick={() => setConfirmOpen(true)}
                        title={t("message.undoEdits")}
                    >
                        <RotateCcw size={12} aria-hidden="true" />
                        {t("message.filesChanged", { count: checkpoint.files.length })}
                    </button>
                )}
            </div>
            <ConfirmModal
                open={confirmOpen}
                title={t("message.undoEditsTitle")}
                message={t("message.undoEditsMessage", { count: checkpoint?.files.length ?? 0 })}
                confirmLabel={t("message.confirmUndoEdits")}
                cancelLabel={t("message.cancelUndoEdits")}
                onCancel={() => setConfirmOpen(false)}
                onConfirm={() => {
                    if (!checkpoint || !onRestoreCheckpoint) return;
                    setBusy(true);
                    setConfirmOpen(false);
                    void onRestoreCheckpoint(checkpoint.id).finally(() => setBusy(false));
                }}
            />
        </>
    );
}
