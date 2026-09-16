/**
 * SubagentPanel — right-side panel listing this session's subagents with the
 * selected one's message stream below.
 *
 * The list is derived from `messages` on every render rather than stored, so
 * switching sessions or workspaces needs no cleanup. The detail area reuses
 * SubagentContext's live / history readers: live wins, and history is pulled
 * lazily the first time a subagent with an empty live stream is opened (that is
 * the historical-replay case — no more push events will arrive for it).
 */

import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import type { DragHandleProps } from "../../hooks/primitives/useDragResize";
import { useSubagent } from "../../hooks/useSubagent";
import { useT } from "../../i18n/useI18n";
import type { UiMessage } from "../../lib/chat/chatUtils";
import { deriveSubagents, filterSubagents, type SubagentEntry } from "../../lib/chat/subagentList";
import { ErrorBoundary } from "../ErrorBoundary";
import { Message } from "../Message";
import { PaneHeader } from "../PaneHeader";
import { Button } from "../ui/Button";
import { RightPanel } from "./RightPanel";
import { SubagentRow } from "./SubagentRow";

/** Prompt preview cap; matches the inline card's former trimPrompt default. */
const PROMPT_MAX = 240;

function trimPrompt(s: string): string {
    return s.length <= PROMPT_MAX ? s : `${s.slice(0, PROMPT_MAX)}…`;
}

export function SubagentPanel({
    messages,
    open,
    selectedSubSessionId,
    onSelect,
    onClose,
    resizeHandleProps,
    resizeLabel,
}: {
    messages: readonly UiMessage[];
    open: boolean;
    selectedSubSessionId: string | null;
    onSelect: (subSessionId: string) => void;
    onClose: () => void;
    resizeHandleProps?: DragHandleProps;
    resizeLabel?: string;
}): ReactElement | null {
    const { t } = useT();
    const [query, setQuery] = useState("");

    const entries = useMemo(() => deriveSubagents(messages), [messages]);
    const shown = useMemo(() => filterSubagents(entries, query), [entries, query]);
    const selected: SubagentEntry | null =
        entries.find((e) => e.subSessionId === selectedSubSessionId) ?? null;

    if (!open) return null;

    return (
        <RightPanel
            title={
                <PaneHeader
                    title={t("subagents.title")}
                    count={entries.length}
                    shownCount={shown.length}
                    query={query}
                    onQueryChange={setQuery}
                />
            }
            onClose={onClose}
            closeLabel={t("app.dismiss")}
            className="subagent-panel"
            resizeHandleProps={resizeHandleProps}
            resizeLabel={resizeLabel}
        >
            {entries.length === 0 ? (
                <div className="subagent-panel-empty">{t("subagents.empty")}</div>
            ) : shown.length === 0 ? (
                <div className="subagent-panel-no-match">{t("subagents.noMatch")}</div>
            ) : (
                <ul className="subagent-panel-list">
                    {shown.map((entry) => (
                        <SubagentRow
                            key={entry.firstToolCallId}
                            entry={entry}
                            selected={entry.subSessionId === selectedSubSessionId}
                            onSelect={onSelect}
                        />
                    ))}
                </ul>
            )}
            <div className="subagent-panel-detail">
                {selected === null || selected.subSessionId === null ? (
                    // "Select one above" points at the list; with no subagents
                    // at all its own empty message is the whole story, and the
                    // two lines read as a contradiction.
                    entries.length > 0 && (
                        <div className="subagent-panel-select-prompt">
                            {t("subagents.selectPrompt")}
                        </div>
                    )
                ) : (
                    // Keyed by subSessionId so switching subagents resets the
                    // detail's own load / error state instead of carrying it over.
                    <ErrorBoundary key={selected.subSessionId}>
                        <SubagentDetail entry={selected} subSessionId={selected.subSessionId} />
                    </ErrorBoundary>
                )}
            </div>
        </RightPanel>
    );
}

/**
 * Detail body for one subagent. Render priority is live > history; when both
 * are empty and no pull has been attempted yet, pull history once. A failed
 * pull is recoverable via retry — the former inline card rendered a dead error
 * line, leaving the user no way forward but reopening the card.
 */
function SubagentDetail({
    entry,
    subSessionId,
}: {
    entry: SubagentEntry;
    subSessionId: string;
}): ReactElement {
    const { t } = useT();
    const { liveMessagesFor, historyMessagesFor, loadSubagentHistory } = useSubagent();

    const live = liveMessagesFor(subSessionId);
    const history = historyMessagesFor(subSessionId);
    const shown = live.length > 0 ? live : history;
    const hasContent = shown.length > 0;

    const [loading, setLoading] = useState(false);
    const [attempted, setAttempted] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const pull = useCallback(() => {
        setAttempted(true);
        setLoading(true);
        setError(null);
        loadSubagentHistory(subSessionId)
            .catch((e: unknown) => {
                setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => setLoading(false));
    }, [loadSubagentHistory, subSessionId]);

    useEffect(() => {
        if (hasContent) return;
        if (attempted) return;
        pull();
    }, [hasContent, attempted, pull]);

    return (
        <>
            {entry.prompt !== "" && (
                <div className="subagent-detail-prompt">
                    <span className="subagent-detail-prompt-label">
                        {t("subagents.promptLabel")}
                    </span>
                    <pre>{trimPrompt(entry.prompt)}</pre>
                </div>
            )}
            {error !== null && (
                <div className="subagent-detail-error">
                    {t("subagents.historyFailed")}: {error}
                    <div className="subagent-detail-retry">
                        <Button variant="ghost" onClick={pull}>
                            {t("subagents.retry")}
                        </Button>
                    </div>
                </div>
            )}
            {!hasContent && error === null && (
                <div className="subagent-detail-status">
                    {loading || !attempted
                        ? entry.status === "running"
                            ? t("subagents.starting")
                            : t("subagents.loading")
                        : t("subagents.noMessages")}
                </div>
            )}
            {hasContent && (
                <div className="subagent-detail-stream">
                    {shown.map((m) => (
                        <Message key={m.id} m={m} />
                    ))}
                </div>
            )}
        </>
    );
}
