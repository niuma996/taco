/**
 * SubagentPanel — right-side panel listing this session's subagents with the
 * selected one's message stream below.
 *
 * The list is derived from `messages` on every render rather than stored, so
 * switching sessions or workspaces needs no cleanup. The detail area reuses
 * SubagentContext's live / history readers: live wins, and history is pulled
 * on open and whenever the selected conversation starts or settles another run.
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
import { Clamp } from "../ui/Clamp";
import { RightPanel } from "./RightPanel";
import { SubagentRow } from "./SubagentRow";

/** Both the prompt block and a user bubble in this pane clamp to this many
 *  lines — the panel is a side column, so anything longer has to fold. */
const PROMPT_MAX_LINES = 5;

export function SubagentPanel({
    messages,
    backgroundSubagents,
    backgroundRunIds,
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
    backgroundRunIds?: Parameters<typeof deriveSubagents>[2];
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
        () => deriveSubagents(messages, backgroundSubagents, backgroundRunIds),
        [messages, backgroundSubagents, backgroundRunIds],
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
 * A live tail may begin at a continuation, so always reconcile history on open
 * and on run transitions. The workspace merges it into the canonical child stream.
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
    const pullKey = `${settled ? "settled" : "open"}:${entry.conversationRunId ?? ""}:${entry.conversationStatus ?? ""}:${entry.conversationToolCallId ?? ""}`;
    const [loading, setLoading] = useState(false);
    const [pulledKey, setPulledKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pullGeneration = useRef(0);

    const pull = useCallback(
        (key: string) => {
            const generation = ++pullGeneration.current;
            setPulledKey(key);
            setLoading(true);
            setError(null);
            loadSubagentHistory(subSessionId)
                .catch((e: unknown) => {
                    if (generation === pullGeneration.current)
                        setError(e instanceof Error ? e.message : String(e));
                })
                .finally(() => {
                    if (generation === pullGeneration.current) setLoading(false);
                });
        },
        [loadSubagentHistory, subSessionId],
    );

    useEffect(() => {
        if (pulledKey === pullKey) return;
        pull(pullKey);
    }, [pullKey, pulledKey, pull]);

    return (
        <>
            {entry.prompt !== "" && (
                <div className="subagent-detail-prompt">
                    <span className="subagent-detail-prompt-label">
                        {t("subagents.promptLabel")}
                    </span>
                    <Clamp lines={PROMPT_MAX_LINES} className="subagent-detail-prompt-text">
                        {entry.prompt}
                    </Clamp>
                </div>
            )}
            {error !== null && (
                <div className="subagent-detail-error">
                    <div role="alert">
                        {t("subagents.historyFailed")}: {error}
                    </div>
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
                        <Message key={m.id} m={m} clampLines={PROMPT_MAX_LINES} />
                    ))}
                </div>
            )}
        </>
    );
}
