/**
 * agent tool view — collapsed shows agentType + description + status;
 * expanded fetches and displays the child session message stream (live + history replay).
 *
 * Live stream: `SubagentContext.liveMessagesFor(subSessionId)`. History replay:
 * on first expand, if the live stream is empty, trigger `loadSubagentHistory`
 * which calls `session.history` and writes to `reducer.childHistoryLoaded`.
 */

import { ChevronRight, Loader2 } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { useSubagent } from "../../hooks/useSubagent";
import type { UiMessage } from "../../lib/chatUtils";
import { Message } from "../Message";
import { truncate } from "./_util";
import { type ToolViewProps, toolViews } from "./registry";

interface AgentToolDetailsShape {
    subSessionId?: unknown;
    agentType?: unknown;
}

interface AgentToolArgsShape {
    subagent_type?: unknown;
    description?: unknown;
    prompt?: unknown;
}

/** Truncate the sub-agent prompt for the summary (default 240 chars). */
function trimPrompt(s: string, max = 240): string {
    return truncate(s, max);
}

export function AgentToolView({ tool }: ToolViewProps): ReactElement {
    const args = (tool.args ?? {}) as AgentToolArgsShape;
    const description = typeof args.description === "string" ? args.description : "";
    const agentTypeFromArgs = typeof args.subagent_type === "string" ? args.subagent_type : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const isRunning = tool.status === "running";
    const isError = tool.status === "error";

    const details = (tool.details ?? {}) as AgentToolDetailsShape;
    const subSessionId =
        typeof details.subSessionId === "string" ? (details.subSessionId as string) : null;
    const agentTypeFromDetails =
        typeof details.agentType === "string" ? (details.agentType as string) : "";
    const agentType = agentTypeFromDetails || agentTypeFromArgs || "agent";

    const [expanded, setExpanded] = useState(false);

    return (
        <div className="agent-card" data-agent-running={isRunning ? "true" : "false"}>
            <button
                type="button"
                className="agent-card-header"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
            >
                <ChevronRight
                    size={12}
                    aria-hidden="true"
                    className={`agent-card-chevron${expanded ? " expanded" : ""}`}
                />
                <span className="agent-card-type">{agentType}</span>
                {description.length > 0 && <span className="agent-card-desc">{description}</span>}
                {isRunning && (
                    <span className="agent-card-running">
                        <Loader2 size={11} className="spin" aria-hidden="true" />
                        running
                    </span>
                )}
                {isError && <span className="agent-card-error">error</span>}
                {subSessionId && (
                    <span className="agent-card-subid" title={subSessionId}>
                        id {subSessionId.slice(0, 8)}
                    </span>
                )}
            </button>
            {expanded && (
                <AgentCardBody subSessionId={subSessionId} prompt={prompt} isRunning={isRunning} />
            )}
        </div>
    );
}

/**
 * Expanded body:
 *   - prompt always shown
 *   - if subSessionId is present, render the live / historical UiMessage stream
 *   - if live is empty and history hasn't loaded, trigger loadSubagentHistory
 */
function AgentCardBody({
    subSessionId,
    prompt,
    isRunning,
}: {
    subSessionId: string | null;
    prompt: string;
    isRunning: boolean;
}) {
    const { liveMessagesFor, historyMessagesFor, loadSubagentHistory } = useSubagent();
    const live: UiMessage[] = subSessionId ? liveMessagesFor(subSessionId) : [];
    const history: UiMessage[] = subSessionId ? historyMessagesFor(subSessionId) : [];
    // Render priority: live > history. After spawn the live stream keeps
    // appending = history + new events.
    // If live is empty AND history isn't loaded yet, trigger loadSubagentHistory.
    const messages: UiMessage[] = live.length > 0 ? live : history;
    const hasHistoryPulled = history.length > 0 || live.length > 0;

    const [historyPulled, setHistoryPulled] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);

    useEffect(() => {
        if (!subSessionId) return;
        if (hasHistoryPulled) return;
        if (historyPulled) return;
        let cancelled = false;
        setHistoryPulled(true);
        loadSubagentHistory(subSessionId)
            .then(() => {
                if (cancelled) return;
            })
            .catch((e) => {
                if (!cancelled) setHistoryError(e instanceof Error ? e.message : String(e));
            });
        return () => {
            cancelled = true;
        };
    }, [subSessionId, hasHistoryPulled, historyPulled, loadSubagentHistory]);

    return (
        <div className="agent-card-body">
            {prompt.length > 0 && (
                <div className="agent-card-prompt">
                    <span className="agent-card-prompt-label">prompt</span>
                    <pre>{trimPrompt(prompt)}</pre>
                </div>
            )}
            {subSessionId && (
                <div className="agent-card-stream">
                    {messages.length === 0 && !historyError && (
                        <div className="agent-card-empty">
                            {isRunning ? "starting…" : "no messages"}
                        </div>
                    )}
                    {historyError && (
                        <div className="agent-card-error">history load failed: {historyError}</div>
                    )}
                    {messages.map((m) => (
                        <Message key={m.id} m={m} />
                    ))}
                </div>
            )}
            {!subSessionId && (
                <div className="agent-card-empty">
                    {isRunning ? "spawning…" : "no sub-session id (tool failed)"}
                </div>
            )}
        </div>
    );
}

toolViews.agent = AgentToolView;
