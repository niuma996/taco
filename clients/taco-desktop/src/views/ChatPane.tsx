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
import { ArrowUp, Paperclip, Square } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { ContextIndicator } from "../components/ContextIndicator";
import { Message } from "../components/Message";
import { SessionInfo } from "../components/SessionInfo";
import { ModelMenu } from "../components/settings/ModelMenu";
import type { ModelOption, ModelSelection } from "../components/settings/ModelPicker";
import { useImageAttachments } from "../hooks/useImageAttachments";
import type { WorkspaceState } from "../hooks/useWorkspaces";
import { useT } from "../i18n/useI18n";
import { defaultThinkingLevelForNewSession, getGlobalConfig } from "../lib/globalConfig";
import { MAX_ATTACHMENTS } from "../lib/imageAttachment";

export interface ChatPaneProps {
    ws: WorkspaceState | undefined;
    input: string;
    attachments: ImageInput[];
    pending: boolean;
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
}

export function ChatPane(props: ChatPaneProps) {
    const {
        ws,
        sidebarCollapsed,
        onToggleSidebar,
        input,
        attachments,
        pending,
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
    } = props;
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const { addFiles, handlePaste, removeAttachment } = useImageAttachments(
        attachments,
        onAttachmentsChange,
    );
    const { t } = useT();

    const canSend = input.trim().length > 0 || attachments.length > 0;

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
                el.scrollTo({ top: 1e9 });
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
            />
            <main ref={mainRef}>
                {(ws?.messages ?? []).map((m) => (
                    <Message key={m.id} m={m} onCommandPermission={onCommandPermission} />
                ))}
            </main>
            {/* Auto-compaction in progress: lock the input UI and surface the top status
                bar. This is a belt-and-suspenders guard — the server's
                awaitCompactionEnd already polls before the next send, so this
                client-side lock mainly protects against rapid double-clicks
                racing the server's wait window. */}
            {compacting && !pending && (
                <output className="input-status input-status--compacting">
                    <span className="input-status__dot" aria-hidden="true" />
                    <span>{t("input.compactingNotice")}</span>
                </output>
            )}
            <footer className="input">
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
                        disabled={pending || compacting}
                        onKeyDown={(e) => {
                            // While an IME composition (CJK) is active, Enter confirms a candidate, not a submit.
                            // keyCode === 229 is a WebKit legacy fallback for older versions.
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (!pending && !compacting && canSend) {
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
                            pending
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
                            disabled={
                                pending || compacting || attachments.length >= MAX_ATTACHMENTS
                            }
                        >
                            <Paperclip size={16} aria-hidden="true" />
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
                                disabled={pending}
                                pendingNote={pending}
                                onOpen={onRefreshModels}
                            />
                        )}
                        <div className="input-right">
                            <ContextIndicator
                                info={contextIndicator.info}
                                loading={contextIndicator.loading}
                                compacting={contextIndicator.compacting}
                                threshold={contextIndicator.threshold}
                                className="input-context-indicator"
                            />
                            {pending ? (
                                <button className="prompt-button stop" onClick={onAbort}>
                                    <Square size={16} aria-hidden="true" />
                                    {t("input.stop")}
                                </button>
                            ) : (
                                <button
                                    className="prompt-button send"
                                    onClick={() => {
                                        const el = textareaRef.current;
                                        if (el) {
                                            el.style.height = "auto";
                                        }
                                        onSend();
                                    }}
                                    disabled={!canSend || pending || compacting}
                                >
                                    <ArrowUp size={16} aria-hidden="true" />
                                    {t("input.send")}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </footer>
        </div>
    );
}
