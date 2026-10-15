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

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragHandleProps } from "../../hooks/primitives/useDragResize";
import { useStickToBottom } from "../../hooks/primitives/useStickToBottom";
import { useSubagent } from "../../hooks/useSubagent";
import { useT } from "../../i18n/useI18n";
import type { UiMessage } from "../../lib/chat/chatUtils";
import { deriveSubagents, filterSubagents, type SubagentEntry } from "../../lib/chat/subagentList";
import { ErrorBoundary } from "../ErrorBoundary";
import { Message } from "../Message";
import { PaneSearch } from "../PaneSearch";
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
    backgroundSubagents,
    open,
    selectedSubSessionId,
    onSelect,
    onClose,
    onStopSubagent,
    resizeHandleProps,
    resizeLabel,
}: {
    messages: readonly UiMessage[];
    /** Live background-spawn record; without it a background child reads as
     *  finished from launch (its tool call says `ok` from the receipt). */
    backgroundSubagents?: Parameters<typeof deriveSubagents>[1];
    open: boolean;
    selectedSubSessionId: string | null;
    onSelect: (subSessionId: string) => void;
    onClose: () => void;
    /** Stop one running subagent (subagent.abort); rows hide the button without it. */
    onStopSubagent?: (subSessionId: string) => void;
    resizeHandleProps?: DragHandleProps;
    resizeLabel?: string;
}): ReactElement | null {
    const { t } = useT();
    const [query, setQuery] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);

    const entries = useMemo(
        () => deriveSubagents(messages, backgroundSubagents),
        [messages, backgroundSubagents],
    );
    const shown = useMemo(() => filterSubagents(entries, query), [entries, query]);
    const selected: SubagentEntry | null =
        entries.find((e) => e.subSessionId === selectedSubSessionId) ?? null;

    // The detail div is shared across selections, so a new selection must
    // re-pin; `open` is in the key because the div does not exist while closed.
    const detailRef = useRef<HTMLDivElement | null>(null);
    useStickToBottom(detailRef, open ? selectedSubSessionId : null);

    if (!open) return null;

    return (
        <RightPanel
            title={
                searchOpen ? null : (
                    <span className="right-panel-heading">
                        {t("subagents.title")}
                        <span className="pane-count-badge">
                            {query.trim() !== ""
                                ? `${shown.length}/${entries.length}`
                                : entries.length}
                        </span>
                    </span>
                )
            }
            actions={
                <PaneSearch query={query} onQueryChange={setQuery} onOpenChange={setSearchOpen} />
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
                            onStop={onStopSubagent}
                        />
                    ))}
                </ul>
            )}
            <div className="subagent-panel-detail" ref={detailRef}>
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
 *
 * The pull is keyed on the run's phase, not just "attempted": a pull taken
 * mid-run is a partial snapshot, and a claude-code child has no live event
 * stream to top it up, so without a second pull once the run settles the panel
 * would stick at whatever existed at first pull (often just the prompt).
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

    const settled = entry.status === "ok" || entry.status === "error" || entry.status === "aborted";
    const pullKey = settled ? "settled" : "open";
    const [loading, setLoading] = useState(false);
    const [pulledKey, setPulledKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const pull = useCallback(
        (key: string) => {
            setPulledKey(key);
            setLoading(true);
            setError(null);
            loadSubagentHistory(subSessionId)
                .catch((e: unknown) => {
                    setError(e instanceof Error ? e.message : String(e));
                })
                .finally(() => setLoading(false));
        },
        [loadSubagentHistory, subSessionId],
    );

    useEffect(() => {
        if (live.length > 0) return;
        if (pulledKey === pullKey) return;
        pull(pullKey);
    }, [live.length, pullKey, pulledKey, pull]);

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
                        <Button variant="ghost" onClick={() => pull(pullKey)}>
                            {t("subagents.retry")}
                        </Button>
                    </div>
                </div>
            )}
            {!hasContent && error === null && (
                <div className="subagent-detail-status">
                    {loading || pulledKey === null
                        ? entry.status === "running" || entry.status === "background"
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
