/**
 * ChatPane — top session-info bar + message stream (messages map + ThinkingBlock)
 * + bottom input. Pure view: takes WorkspaceState and send/thinking callbacks.
 * Holds no business state (the parent owns the controlled textarea value).
 * Message rendering, attachment logic, model menu and thinking slider live in
 * their own modules; this file keeps only the layout shell.
 */

import type {
    CommandPermissionScope,
    ImageInput,
    SessionContextInfoResult,
    ThinkingLevel,
} from "@taco-ai/protocol";
import { ArrowUp, ImageIcon, Square } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { ContextIndicator } from "../components/ContextIndicator";
import { EmptyChatState } from "../components/EmptyChatState";
import { Message } from "../components/Message";
import { QueueBar } from "../components/QueueBar";
import { SessionInfo } from "../components/SessionInfo";
import { ModelMenu } from "../components/settings/ModelMenu";
import type { ModelOption, ModelSelection } from "../components/settings/ModelPicker";
import { useImageAttachments } from "../hooks/primitives/useImageAttachments";
import type { WorkspaceState } from "../hooks/useWorkspaces";
import { useT } from "../i18n/useI18n";
import type { QueuedUiItem } from "../lib/chat/chatUtils";
import { isLastInTurn, isTurnInProgress } from "../lib/chat/chatUtils";
import { defaultThinkingLevelForNewSession, getGlobalConfig } from "../lib/globalConfig";
import { MAX_ATTACHMENTS } from "../lib/imageAttachment";

export interface ChatPaneProps {
    ws: WorkspaceState | undefined;
    input: string;
    attachments: ImageInput[];
    /**
     * Anything in flight that warrants a Stop button: the active session's run
     * OR agent-tool cards streaming from background sessions.
     */
    busy: boolean;
    /**
     * The active session has a turn in flight (run_start without its run_end).
     * Unlocks the composer: Enter / the send button deliver the text as an
     * in-run steer instead of starting a new turn.
     */
    runInFlight: boolean;
    /** Not-yet-consumed steer/followUp entries for the active session (QueueBar). */
    queuedItems: QueuedUiItem[];
    /** Cancel one queued entry (QueueBar row cancel button). */
    onCancelQueued: (item: QueuedUiItem) => void;
    /** Sidebar collapsed state + toggle, surfaced as a button on the session-info bar. */
    sidebarCollapsed: boolean;
    onToggleSidebar: () => void;
    /**
     * Backend auto-compaction in progress (compaction_started push received, finished not yet).
     * Disables input/Enter submit during compaction and shows a "compacting" badge — paired with
     * the server-side `awaitCompactionEnd` so users never hit pi's AgentHarnessError("busy").
     */
    compacting: boolean;
    contextIndicator: {
        info: SessionContextInfoResult | null;
        loading: boolean;
        compacting?: boolean;
        threshold?: number;
        onCompact?: () => void;
        sessionBusy?: boolean;
    };
    onInputChange: (next: string) => void;
    onAttachmentsChange: (next: ImageInput[]) => void;
    onSend: () => void;
    onAbort: () => void;
    onEnter: () => void;
    activeLevel: ThinkingLevel | null;
    onLevelChange: (next: ThinkingLevel) => void;
    activeModel: ModelSelection | null;
    onModelChange: (next: ModelSelection) => void;
    modelOptions: ModelOption[];
    /** Force-refresh the model list when the menu opens. */
    onRefreshModels?: () => void;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
    onCopySessionId: (sid: string) => void;
    copiedSessionId: string | null;
    onCommandPermission: (
        requestId: string,
        approved: boolean,
        scope: CommandPermissionScope,
    ) => void;
    /** Show / hide the file-tree drawer — surfaced as a button on the
     *  session-info bar. Suppressed for IM conversations by the caller. */
    onToggleFiles?: () => void;
    filesOpen?: boolean;
    /** Show / hide the task panel — surfaced as a button on the
     *  session-info bar. */
    onToggleTasks?: () => void;
    tasksOpen?: boolean;
    /** Show / hide the subagent panel — surfaced as a button on the
     *  session-info bar. */
    onToggleSubagents?: () => void;
    subagentsOpen?: boolean;
    subagentDot?: "none" | "idle" | "active";
    /** Start a new session — same action as the topbar "new chat" chip. */
    onNewSession?: () => void;
    /** Disable the new-session button (no workspace / IM conversation). */
    newSessionDisabled?: boolean;
    /** When true, suppress the file-tree button (no filesystem to browse). */
    isIm?: boolean;
    /** Opaque floating overlay anchored above the input footer (currently the
     *  LLM dump dock). Composed by the caller; the pane only places it. */
    llmDumpDock?: ReactNode;
}

export function ChatPane(props: ChatPaneProps) {
    const {
        ws,
        sidebarCollapsed,
        onToggleSidebar,
        input,
        attachments,
        busy,
        runInFlight,
        queuedItems,
        onCancelQueued,
        compacting,
        contextIndicator,
        onInputChange,
        onAttachmentsChange,
        onSend,
        onAbort,
        onEnter,
        activeLevel,
        onLevelChange,
        activeModel,
        onModelChange,
        modelOptions,
        onRefreshModels,
        textareaRef,
        onCopySessionId,
        copiedSessionId,
        onCommandPermission,
        onToggleFiles,
        filesOpen,
        onToggleTasks,
        tasksOpen,
        onToggleSubagents,
        subagentsOpen,
        subagentDot,
        onNewSession,
        newSessionDisabled,
        isIm,
        llmDumpDock,
    } = props;
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const { addFiles, handlePaste, removeAttachment } = useImageAttachments(
        attachments,
        onAttachmentsChange,
    );
    const { t } = useT();

    const canSend = input.trim().length > 0 || attachments.length > 0;
    // Fresh chat (no messages yet) — covers both a brand-new session and one
    // that was just created via "New chat" but never prompted.
    const isEmptyChat = (ws?.messages ?? []).length === 0;

    // chat scroll auto-follow.
    //
    // Attach observer + scroll listener to the <main> rendered by ChatPane itself so they
    // clean up on unmount/remount. Putting them in App (which never unmounts) and forwarding
    // via ref would leak to a detached node when the <main> is replaced by a conditional
    // render on tab switch — the new node would have no observer, breaking auto-scroll.
    //
    // Stick maintenance: scroll events update the stick flag (observer fires after content
    // is added so distance-from-bottom is measured correctly). rAF double-checks before
    // scrolling to avoid a race where the user scrolls up between the scroll event and
    // the rAF callback.
    const mainRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = mainRef.current;
        if (!el) return;
        let rafId: number | null = null;
        const NEAR_BOTTOM_PX = 80;
        let stick = true;
        const onScroll = (): void => {
            stick = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        const schedule = (): void => {
            if (!stick) return;
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (!stick) return;
                el.scrollTo({ top: el.scrollHeight });
            });
        };
        const mo = new MutationObserver(schedule);
        mo.observe(el, { childList: true, subtree: true, characterData: true });
        const ro = new ResizeObserver(schedule);
        ro.observe(el);
        return () => {
            el.removeEventListener("scroll", onScroll);
            mo.disconnect();
            ro.disconnect();
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, []);

    // On mount, snap to the bottom — covers the case where the previous session
    // left the scroll position non-zero.
    useEffect(() => {
        const el = mainRef.current;
        if (!el) return;
        el.scrollTo({ top: 1e9 });
    }, []);

    // After-send snap to bottom: an empty `input` signals a just-completed send.
    // The MutationObserver will fire for the incoming assistant message, but
    // `stick` may be false if the user had scrolled up before sending. This
    // effect re-asserts stick=true on each input clear so the first assistant
    // message lands with the viewport already at the bottom.
    const prevInputRef = useRef<string>("");
    useEffect(() => {
        const prev = prevInputRef.current;
        prevInputRef.current = input;
        if (!prev || input) return;
        const el = mainRef.current;
        if (!el) return;
        el.scrollTo({ top: 1e9 });
    }, [input]);

    // Show a scrollbar only when the textarea exceeds the maximum row height;
    // otherwise hide it (WebView's default overflow:auto always reserves scrollbar width).
    // biome-ignore lint/correctness/useExhaustiveDependencies: textareaRef ref is stable; input changes the textarea content which changes scrollHeight, so the effect must re-run
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        // +1px guard against sub-pixel jitter when comparing scrollHeight vs clientHeight
        const overflowing = el.scrollHeight > el.clientHeight + 1;
        el.style.overflowY = overflowing ? "auto" : "hidden";
    }, [input]);

    return (
        <div className="main-col">
            <SessionInfo
                ws={ws}
                onCopy={onCopySessionId}
                copiedSessionId={copiedSessionId}
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={onToggleSidebar}
                onToggleFiles={onToggleFiles}
                filesOpen={filesOpen}
                onToggleTasks={onToggleTasks}
                tasksOpen={tasksOpen}
                onToggleSubagents={onToggleSubagents}
                subagentsOpen={subagentsOpen}
                subagentDot={subagentDot}
                onNewSession={onNewSession}
                newSessionDisabled={newSessionDisabled}
                isIm={isIm}
            />
            <main ref={mainRef}>
                {isEmptyChat ? (
                    <EmptyChatState />
                ) : (
                    (() => {
                        const messages = ws?.messages ?? [];
                        return messages.map((m, i) => (
                            <Message
                                key={m.id}
                                m={m}
                                isLastInTurn={isLastInTurn(messages, i)}
                                isTurnInProgress={isTurnInProgress(messages, i, busy)}
                                onCommandPermission={onCommandPermission}
                            />
                        ));
                    })()
                )}
            </main>
            <footer className="input">
                {/* Same column as .input-card so the banner inherits the footer's
                    padding (including the 10% reading gutter). Shown for both
                    auto and manual compact; `busy` is not a gate — background
                    agent-tool activity must not hide a parent-session compact. */}
                {compacting && (
                    <output className="input-status input-status--compacting">
                        <span className="input-status__dot" aria-hidden="true" />
                        <span>{t("input.compactingNotice")}</span>
                    </output>
                )}
                <QueueBar items={queuedItems} onCancel={onCancelQueued} />
                <div className="input-card">
                    {attachments.length > 0 && (
                        <div className="attachment-bar">
                            {attachments.map((a, i) => (
                                // Thumbnail key uses mimeType + first/last 8 chars of the data payload — the
                                // same image yields the same key, so removing a middle
                                // attachment won't be mistaken for a reorder by React.
                                <div
                                    key={`${a.mimeType}-${a.data.slice(0, 8)}-${a.data.slice(-8)}`}
                                    className="attachment-thumb-wrap"
                                >
                                    <img
                                        className="attachment-thumb"
                                        src={`data:${a.mimeType};base64,${a.data}`}
                                        alt=""
                                    />
                                    <button
                                        type="button"
                                        className="attachment-remove"
                                        aria-label={t("input.removeAttachment")}
                                        onClick={() => removeAttachment(i)}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <textarea
                        ref={textareaRef}
                        rows={1}
                        value={input}
                        onChange={(e) => onInputChange(e.target.value)}
                        onPaste={handlePaste}
                        disabled={compacting}
                        onKeyDown={(e) => {
                            // While an IME composition (CJK) is active, Enter confirms a candidate, not a submit.
                            // keyCode === 229 is a WebKit legacy fallback for older versions.
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                // The composer stays unlocked during a run: Enter
                                // delivers the text as an in-run steer. Only a
                                // compaction locks it.
                                if (!compacting && canSend) {
                                    // Reset the textarea height before sending so the input snaps back to a
                                    // single line ahead of the React re-render — avoids a
                                    // single-frame flicker of the multi-line state.
                                    const el = textareaRef.current;
                                    if (el) {
                                        el.style.height = "auto";
                                    }
                                    onEnter();
                                }
                            }
                        }}
                        placeholder={
                            runInFlight
                                ? t("input.placeholderRunning")
                                : compacting
                                  ? t("input.placeholderCompacting")
                                  : t("input.placeholderIdle")
                        }
                    />
                    <div className="input-controls">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            hidden
                            onChange={(e) => {
                                const files = e.target.files;
                                if (files && files.length > 0) void addFiles(files);
                                // Allow re-selecting the same file to retrigger the change — clear value.
                                e.target.value = "";
                            }}
                        />
                        <button
                            type="button"
                            className="prompt-button attach"
                            aria-label={t("input.attachImages")}
                            title={t("input.attachImages")}
                            onClick={() => fileInputRef.current?.click()}
                            // Unlocked during a run: steer passthrough carries images
                            // (session.steer accepts `images`). Compaction still locks —
                            // its handler refuses new input until the compaction settles.
                            disabled={compacting || attachments.length >= MAX_ATTACHMENTS}
                        >
                            <ImageIcon size={16} aria-hidden="true" />
                        </button>
                        {activeModel && (
                            <ModelMenu
                                value={activeModel}
                                options={modelOptions}
                                onModelChange={onModelChange}
                                thinkingValue={
                                    activeLevel ??
                                    defaultThinkingLevelForNewSession(getGlobalConfig().global)
                                }
                                onThinkingChange={onLevelChange}
                                disabled={busy}
                                pendingNote={busy}
                                onOpen={onRefreshModels}
                            />
                        )}
                        <div className="input-right">
                            {!isEmptyChat && (
                                <ContextIndicator
                                    info={contextIndicator.info}
                                    loading={contextIndicator.loading}
                                    compacting={contextIndicator.compacting}
                                    threshold={contextIndicator.threshold}
                                    onCompact={contextIndicator.onCompact}
                                    sessionBusy={contextIndicator.sessionBusy}
                                    className="input-context-indicator"
                                />
                            )}
                            {(busy || compacting) && (
                                <button
                                    type="button"
                                    className="prompt-button stop"
                                    onClick={onAbort}
                                >
                                    <Square size={16} aria-hidden="true" />
                                    {t("input.stop")}
                                </button>
                            )}
                            {runInFlight && (
                                // Steer send: coexists with Stop so an in-run
                                // message and an abort are both one click away.
                                <button
                                    type="button"
                                    className="prompt-button send"
                                    onClick={() => {
                                        const el = textareaRef.current;
                                        if (el) {
                                            el.style.height = "auto";
                                        }
                                        onSend();
                                    }}
                                    disabled={!canSend || compacting}
                                >
                                    <ArrowUp size={16} aria-hidden="true" />
                                    {t("input.sendSteer")}
                                </button>
                            )}
                            {!runInFlight && !compacting && (
                                // Background agent-tool activity (`busy` without
                                // `runInFlight`) still allows a normal prompt: the
                                // active session is idle. Without this branch that
                                // state had Enter but no send button.
                                <button
                                    type="button"
                                    className="prompt-button send"
                                    onClick={() => {
                                        const el = textareaRef.current;
                                        if (el) {
                                            el.style.height = "auto";
                                        }
                                        onSend();
                                    }}
                                    disabled={!canSend}
                                >
                                    <ArrowUp size={16} aria-hidden="true" />
                                    {t("input.send")}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
                {llmDumpDock}
            </footer>
        </div>
    );
}
