/**
 * One row in the subagent list: status icon + agent type + description.
 *
 * A `detached` entry (no subSessionId — its toolResult never landed) renders
 * disabled: there is no child session left to open, so a clickable row would
 * lead nowhere.
 */

import { CheckCircle2, Circle, Loader2, Square, XCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useT } from "../../i18n/useI18n";
import type { SubagentEntry, SubagentStatus } from "../../lib/chat/subagentList";
import { IconButton } from "../ui/IconButton";

function StatusIcon({ status }: { status: SubagentStatus }): ReactElement {
    switch (status) {
        case "running":
            return (
                <Loader2
                    size={13}
                    className="subagent-row-icon subagent-row-icon--running spin"
                    aria-hidden="true"
                />
            );
        // Same spinner as `running`: from the user's side both mean "still
        // working". The distinction is only in where liveness came from.
        case "background":
            return (
                <Loader2
                    size={13}
                    className="subagent-row-icon subagent-row-icon--running spin"
                    aria-hidden="true"
                />
            );
        case "ok":
            return <CheckCircle2 size={13} className="subagent-row-icon" aria-hidden="true" />;
        case "error":
            return (
                <XCircle
                    size={13}
                    className="subagent-row-icon subagent-row-icon--error"
                    aria-hidden="true"
                />
            );
        case "detached":
            return (
                <Circle
                    size={13}
                    className="subagent-row-icon subagent-row-icon--detached"
                    aria-hidden="true"
                />
            );
        // A deliberate stop renders neutral like `detached`, not red like
        // `error`: the user asked for this.
        case "aborted":
            return (
                <Square
                    size={13}
                    className="subagent-row-icon subagent-row-icon--stopped"
                    aria-hidden="true"
                />
            );
    }
}

export function SubagentRow({
    entry,
    selected,
    onSelect,
    onStop,
}: {
    entry: SubagentEntry;
    selected: boolean;
    onSelect: (subSessionId: string) => void;
    /** Stop this subagent without aborting the whole session (subagent.abort). */
    onStop?: (subSessionId: string) => void;
}): ReactElement {
    const { t } = useT();
    const detached = entry.subSessionId === null;
    const stoppable = (entry.status === "running" || entry.status === "background") && !detached;
    const className = [
        "subagent-row",
        selected ? "selected" : "",
        detached ? "subagent-row--detached" : "",
        stoppable ? "subagent-row--stoppable" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <li className="subagent-row-item">
            <button
                type="button"
                className={className}
                disabled={detached}
                aria-current={selected ? "true" : undefined}
                title={detached ? t("subagents.detached") : entry.description || entry.agentType}
                onClick={() => {
                    if (entry.subSessionId !== null) onSelect(entry.subSessionId);
                }}
            >
                <StatusIcon status={entry.status} />
                <span className="subagent-row-type">{entry.agentType}</span>
                {entry.description !== "" && (
                    <span className="subagent-row-desc">{entry.description}</span>
                )}
            </button>
            {stoppable && entry.subSessionId !== null && onStop !== undefined && (
                // Outline-only read as a checkbox, so the button carries the
                // weight instead: filled danger red, same as the composer's
                // Stop. A solid glyph inside a filled square is the stop
                // convention; an outlined one just looks like a tick box.
                <IconButton
                    className="subagent-row-stop"
                    title={t("subagents.stop")}
                    aria-label={t("subagents.stop")}
                    onClick={() => onStop(entry.subSessionId as string)}
                >
                    <Square size={10} fill="currentColor" aria-hidden="true" />
                </IconButton>
            )}
        </li>
    );
}
