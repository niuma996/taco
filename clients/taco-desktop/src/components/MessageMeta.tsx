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

import { useNow } from "../hooks/useNow";
import { useT, useUiLanguage } from "../i18n/useI18n";
import { formatRelativeTime } from "../lib/relativeTime";
import { CopyButton } from "./ui/CopyButton";

export interface MessageMetaProps {
    /** Epoch ms for the row's timestamp. */
    ts: number;
    /** Text shipped to the clipboard on copy. */
    text: string;
}

export function MessageMeta({ ts, text }: MessageMetaProps) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    return (
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
        </div>
    );
}
