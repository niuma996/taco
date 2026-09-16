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

import { useT } from "../i18n/useI18n";
import { CopyButton } from "./ui/CopyButton";

export interface MessageMetaProps {
    /** Epoch ms for the row's timestamp. */
    ts: number;
    /** Text shipped to the clipboard on copy. */
    text: string;
}

/** Format epoch ms as `yyyy-MM-DD HH:mm:ss` in the local timezone. */
function formatTimestamp(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
}

export function MessageMeta({ ts, text }: MessageMetaProps) {
    const { t } = useT();
    return (
        <div className="message-meta">
            <time className="message-meta__time" dateTime={new Date(ts).toISOString()}>
                {formatTimestamp(ts)}
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
