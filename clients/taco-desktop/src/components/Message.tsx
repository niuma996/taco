/**
 * Message — single message renderer (user / system / tool / assistant).
 * Assistant messages contain thinking blocks (ThinkingBlock, defined here)
 * + markdown + tool cards.
 *
 * We don't render a top role label (user/assistant/tool/system text + icon)
 * — the message kind is conveyed by background color and content shape,
 * cutting visual noise.
 */

import type { CommandPermissionRequest, CommandPermissionScope } from "@taco-ai/protocol";
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useStickToBottom } from "../hooks/primitives/useStickToBottom";
import { useT } from "../i18n/useI18n";
import {
    isEmptyAssistant,
    type UiMessage,
    type UiThinkingBlock,
    type UiToolCall,
} from "../lib/chat/chatUtils";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
    CommandPermissionPrompt,
    type CommandPermissionPromptRequest,
} from "./CommandPermissionPrompt";
import { MessageMeta } from "./MessageMeta";
import { ToolCardShell } from "./ToolCardShell";
import { Clamp } from "./ui/Clamp";

/**
 * memo: applyEventToMessages emits a new reference only for the affected
 * message, so the rest of the list keeps referential equality. Shallow-
 * comparing `m` lets completed messages skip re-rendering during streaming,
 * avoiding per-push re-runs of the full conversation's shiki markdown
 * pipeline.
 */
export const Message = memo(function Message({
    m,
    isLastInTurn = false,
    isTurnInProgress = false,
    clampLines,
    highlighted,
    onCommandPermission,
    pendingPermissionRequests,
}: {
    m: UiMessage;
    /**
     * This message closes its turn (user row, or the final assistant of the
     * chain the previous user triggered). Decides whether a meta row belongs.
     */
    isLastInTurn?: boolean;
    /**
     * The turn containing this message is still running (tool running, or the
     * session is busy). When true the meta row is hidden even on a closing
     * message — it shows up only after the turn actually settles.
     */
    isTurnInProgress?: boolean;
    /**
     * Collapse the user bubble's text to this many lines, expanding on click.
     * The subagent panel sets it because its stream is a narrow side pane whose
     * prompt can run far past the fold; the main chat has the width to show a
     * prompt in full, so it leaves this unset.
     */
    clampLines?: number;
    /**
     * Mark the row as the landing spot of a guide jump. Only the user rows
     * carry the navigation target, so the pulse belongs to them alone.
     */
    highlighted?: boolean;
    onCommandPermission?: (
        requestId: string,
        approved: boolean,
        scope: CommandPermissionScope,
    ) => void;
    /** requestId → request, for approvals still awaiting a decision. Passed as a
     *  live reference rather than a lookup fn so `memo` stays effective. */
    pendingPermissionRequests?: Readonly<Record<string, CommandPermissionRequest>>;
}) {
    const showMeta = isLastInTurn && !isTurnInProgress;
    if (m.kind === "user") {
        return (
            <div
                className={`message user${highlighted ? " message--navigation-target" : ""}`}
                data-message-id={m.id}
            >
                {m.images && m.images.length > 0 && (
                    <div className="message-images">
                        {m.images.map((img, i) => (
                            <img
                                key={`${img.mimeType}-${img.data.slice(0, 8)}-${img.data.slice(-8)}-${i}`}
                                className="message-image"
                                src={`data:${img.mimeType};base64,${img.data}`}
                                alt=""
                            />
                        ))}
                    </div>
                )}
                {clampLines === undefined ? (
                    <div className="message-text">{m.text}</div>
                ) : (
                    <Clamp lines={clampLines} className="message-text">
                        {m.text}
                    </Clamp>
                )}
                {showMeta && <MessageMeta ts={m.ts} text={m.text} />}
            </div>
        );
    }
    if (m.kind === "system") {
        return (
            <div className="message system">
                <div className="message-text">{m.text}</div>
            </div>
        );
    }
    if (m.kind === "tool") {
        return (
            <div className="message tool">
                <div className="message-text">{m.text}</div>
            </div>
        );
    }
    // A settled turn with nothing to show must not leave an empty frame; while
    // in flight the empty bubble is the streaming placeholder.
    if (isEmptyAssistant(m) && !isTurnInProgress) return null;
    return (
        <div className="message assistant">
            {m.thinking.map((b, i) => (
                <ThinkingBlock key={`${m.id}-think-${i}`} block={b} />
            ))}
            {m.text && <AssistantMarkdown text={m.text} />}
            {m.tools.map((tool) => (
                <ToolCardShell key={`${m.id}-${tool.id}`} tool={tool}>
                    <CommandPermissionActions
                        tool={tool}
                        onResolve={onCommandPermission}
                        pendingPermissionRequests={pendingPermissionRequests}
                    />
                </ToolCardShell>
            ))}
            {showMeta && <MessageMeta ts={m.ts} text={m.text} />}
        </div>
    );
});

function CommandPermissionActions({
    tool,
    onResolve,
    pendingPermissionRequests,
}: {
    tool: UiToolCall;
    onResolve?: (requestId: string, approved: boolean, scope: CommandPermissionScope) => void;
    pendingPermissionRequests?: Readonly<Record<string, CommandPermissionRequest>>;
}) {
    const request = (
        tool.details as { commandPermission?: CommandPermissionPromptRequest } | undefined
    )?.commandPermission;
    if (!request || !onResolve) return null;
    // The pending table, not the card's status, decides this. A background spawn's
    // card reads `ok` from the moment it launches, so a status gate hides every
    // approval a running subagent asks for. The table is cleared by the
    // `command_permission.resolved` push on every settle path. Falling back to
    // `running` when no table is supplied keeps callers that don't track approvals working.
    const stillPending = pendingPermissionRequests
        ? request.requestId in pendingPermissionRequests
        : tool.status === "running";
    if (!stillPending) return null;
    return (
        <CommandPermissionPrompt
            request={request}
            onResolve={onResolve}
            className="tool-card-permission"
        />
    );
}

function ThinkingBlock({ block }: { block: UiThinkingBlock }) {
    const { t } = useT();
    // Streaming blocks default open; historical / completed blocks default
    // closed. We layer a `userOverridden` flag on top so manual clicks always
    // win — until the block's default flips (e.g. streaming → completed), at
    // which point we clear the override and re-apply the default. A plain
    // useState would freeze the initial default and never auto-collapse when
    // the block finishes.
    const [userOverridden, setUserOverridden] = useState(false);
    // An open block renders capped at ~10 lines with internal scroll (newest
    // line visible) until the user explicitly expands it to full height.
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(false);
    const [showFade, setShowFade] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const isHistorical = block.isHistorical === true;
    const isStreaming = !isHistorical && block.endedAt === undefined;
    const defaultOpen = isStreaming;
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — effect must re-run when the block transitions from streaming to completed so the user override resets and the block auto-collapses.
    useEffect(() => {
        setUserOverridden(false);
        setExpanded(false);
    }, [block.endedAt]);
    const open = userOverridden ? !defaultOpen : defaultOpen;
    const preview = open && !expanded;
    const toggle = () => {
        setUserOverridden((prev) => !prev);
        setExpanded(false);
    };

    // Keep the preview on the newest line while the user hasn't scrolled
    // away. Keyed on the preview being mounted: the node only exists then.
    const previewMounted = open && preview && !block.redacted && block.thinking.length > 0;
    useStickToBottom(scrollRef, previewMounted);

    // The expand affordance only exists when the content actually exceeds the
    // preview cap; short blocks read in full without it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: block.thinking is the trigger — growing content can cross the cap and must re-measure overflow.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !preview) return;
        setOverflowing(el.scrollHeight > el.clientHeight + 1);
    }, [block.thinking, preview]);

    const handleScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        setShowFade(el.scrollTop > 0);
    };

    const label = (() => {
        if (block.redacted) return "Thinking (redacted)";
        if (isStreaming) return "Thinking…";
        if (isHistorical) return "Thought";
        const endedAt = block.endedAt as number;
        const seconds = (endedAt - (block.startedAt ?? endedAt)) / 1000;
        return `Thought for ${seconds.toFixed(1)}s`;
    })();

    return (
        <div className="thinking-block">
            <button type="button" className="thinking-header" onClick={toggle} aria-expanded={open}>
                <ChevronRight
                    size={11}
                    className={`thinking-chevron ${open ? "thinking-chevron--open" : ""}`}
                    aria-hidden="true"
                />
                <span>{label}</span>
            </button>
            {open &&
                !block.redacted &&
                block.thinking.length > 0 &&
                (preview ? (
                    <div className="thinking-viewport">
                        <div
                            ref={scrollRef}
                            className="thinking-body thinking-body--preview"
                            onScroll={handleScroll}
                        >
                            {block.thinking}
                        </div>
                        {showFade && <div className="thinking-fade" aria-hidden="true" />}
                        {overflowing && (
                            <button
                                type="button"
                                className="thinking-expand"
                                onClick={() => setExpanded(true)}
                            >
                                {t("message.thinkingShowAll")}
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="thinking-body">{block.thinking}</div>
                ))}
        </div>
    );
}
