/**
 * One row in the subagent list: status icon + agent type + description.
 *
 * A `detached` entry (no subSessionId — its toolResult never landed) renders
 * disabled: there is no child session left to open, so a clickable row would
 * lead nowhere.
 */

import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useT } from "../../i18n/useI18n";
import type { SubagentEntry, SubagentStatus } from "../../lib/chat/subagentList";

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
    }
}

export function SubagentRow({
    entry,
    selected,
    onSelect,
}: {
    entry: SubagentEntry;
    selected: boolean;
    onSelect: (subSessionId: string) => void;
}): ReactElement {
    const { t } = useT();
    const detached = entry.subSessionId === null;
    const className = [
        "subagent-row",
        selected ? "selected" : "",
        detached ? "subagent-row--detached" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <li>
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
        </li>
    );
}
