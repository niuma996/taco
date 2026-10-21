/**
 * useWorkspaces — workspace / session state machine, persistence, and CRUD.
 *
 * Domain state lives in the workspaces reducer; per-session thinking level and
 * model are delegated to useSessionSettings. notifications is a plain useState,
 * kept out of the reducer so error display does not pollute business state.
 * input / pendingDeleteSession / confirmNewSession stay in App.tsx (UI state).
 */

import type { ImageInput, SupportedLocale, ThinkingLevel } from "@taco-ai/protocol";
import { asSessionId, asWorkspaceId, ErrorCodes, IM_CWD_PREFIX } from "@taco-ai/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ModelSelection } from "../components/settings/ModelPicker";
import { useT } from "../i18n/useI18n";
import { historyToUiMessages, type QueuedUiItem, type UiMessage } from "../lib/chat/chatUtils";
import {
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../lib/chat/workspaceReducer";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { getGlobalConfig } from "../lib/globalConfig";
import type { AppNotification, PushNotificationOptions } from "../lib/notifications";
import type { SnapshotRecovery } from "../lib/sessionPushProcessor";
import type { AskUserPayload } from "./useAskUser";
import { useSessionSettings } from "./useSessionSettings";
import type { SidecarAction } from "./useSidecarStream";
import { useWorkspaceLifecycle } from "./useWorkspaceLifecycle";

export type { SessionMeta, WorkspaceState } from "../lib/chat/workspaceReducer";

// ─────────────────────────────────────────────────────────────────────
// useWorkspaces
// ─────────────────────────────────────────────────────────────────────

export interface UseWorkspacesApi {
    // ── state (read-only) ──
    workspaces: Record<string, WorkspaceState>;
    activeCwd: string;
    activeWs: WorkspaceState | undefined;
    sessionLevels: Record<string, ThinkingLevel>;
    /** Newest first. Backs the topbar notification bell. */
    notifications: AppNotification[];
    /** See `UseWorkspaceLifecycleApi.defaultCwdSettled`. */
    defaultCwdSettled: boolean;

    // ── top-level lifecycle ──
    /** Handle SidecarAction — entry paired with useSidecarStream's onAction. */
    dispatch: (action: SidecarAction) => void;
    /** Dispatch WorkspaceAction directly (for view components to fire non-push actions, e.g. history expand fetch). */
    dispatchWs: (action: WorkspaceAction) => void;
    /**
     * Notification setter (kept out of workspaces reducer — error display is not
     * business state). Defaults to a `client`-sourced error, which is what every
     * caller replying to a user action wants; sidecar-stream callers pass
     * `source: "sidecar"` so the row lands in the bell without a toast. `kind`
     * lets a consumer filter the list; repeats of the same text coalesce.
     */
    pushNotification: (msg: string, opts?: PushNotificationOptions) => void;
    /** Drop one notification by id. */
    dismissNotification: (id: number) => void;
    /** Drop every notification — used by the bell's "clear all". */
    clearNotifications: () => void;

    // ── workspace CRUD ──
    initFromStorage: () => Promise<void>;
    /** Called after sidecar restart: refetch every workspace's sessions and attach the first. */
    reloadAllWorkspaces: () => Promise<void>;
    /** Sidebar "load more" — appends the next page using the current cursor. */
    loadMoreSessions: (cwd: string) => Promise<void>;
    /**
     * Resolve `true` when the workspace was ensured on the sidecar and is
     * now the active one; `false` if validation failed or the load/switch
     * step threw. Errors are already surfaced via toast + the notification bell —
     * the boolean is for callers (e.g. onboarding) that need to gate the next
     * UI step on actual success. The previous fire-and-forget signature is
     * intentionally tightened; the only other caller (`browseAndOpen`)
     * ignores the return value.
     */
    openWorkspace: (rawCwd: string) => Promise<boolean>;
    browseAndOpen: () => Promise<void>;
    switchWorkspace: (cwd: string) => Promise<void>;
    attachSession: (cwd: string, sid: string) => Promise<void>;
    /**
     * Open an IM conversation (a passive im:// cwd the sidecar surfaced via
     * channels.listConversations). Unlike openWorkspace, this does NOT call
     * persistCwds: IM conversations are not user-picked folders, so they
     * must not appear in the next session's "reopen" list or in the topbar
     * WorkspacePicker's project dropdown. It also seeds an empty
     * WorkspaceState via INIT (required because attachSession's ATTACH
     * reducer case is a no-op when no entry exists for the cwd).
     */
    openImConversation: (cwd: string, sid: string, isCurrent?: () => boolean) => Promise<void>;
    /** Rebuild a session after the sidecar's bounded realtime replay window has expired. */
    restoreSessionSnapshot: (
        cwd: string,
        sid: string,
        sessionKind: "main" | "subagent",
    ) => Promise<SnapshotRecovery>;
    deleteSession: (cwd: string, sid: string) => Promise<void>;
    renameSession: (cwd: string, sid: string, name: string) => Promise<void>;

    // ── session lifecycle ──
    /**
     * Clear the current active session + messages without any backend call.
     * The first real send creates the session on the server and pulls the id
     * from the response. Sessions list is preserved so the user can re-attach
     * to a prior chat from the sidebar.
     */
    beginPendingNewSession: (cwd: string) => void;
    /**
     * Send a prompt. Return value signals "did it actually reach the backend":
     *  - true: sent (or new session created with initialPrompt); caller may clear the input.
     *  - false: empty after trim with no attachments / sessionPrompt threw; input should stay.
     *
     * When the server reports `session_busy` (a run is already in flight), this
     * degrades to steerPrompt once — the user's text is delivered as an in-run
     * steer rather than rejected. See STEER_PROMPT_HANDOFF for why the handoff
     * cannot bounce more than once.
     */
    sendPrompt: (text: string, images?: ImageInput[]) => Promise<boolean>;
    /**
     * Enqueue a steer message on the session's active run. Same return contract
     * as sendPrompt. If the server reports the run is already over (`mode:
     * "idle"`), this degrades to sendPrompt once so the text is not lost.
     */
    steerPrompt: (text: string, images?: ImageInput[]) => Promise<boolean>;
    /** Cancel one not-yet-consumed queue entry by server entryId (QueueBar row). */
    cancelQueued: (entryId: string) => Promise<void>;
    /**
     * Abort the active turn. Resolves to the drained steer/follow-up texts (in
     * drain order) so the caller can restore them into the composer — an
     * interrupted steer is user input, not garbage. Empty array when nothing
     * was queued or the abort did not apply.
     */
    abortPrompt: () => Promise<string[]>;

    // ── thinking level ──
    setSessionLevel: (next: ThinkingLevel) => Promise<void>;
    /** Thinking level displayed for the current session. */
    activeLevel: ThinkingLevel | null;

    // ── model ──
    setSessionModel: (next: ModelSelection) => Promise<void>;
    /** Model displayed for the current session; null if no override and still loading. */
    activeModel: ModelSelection | null;

    // ── subagent ──
    /**
     * Lazily load a child session's history (called when user first expands the agent card).
     * Writes to `childHistoryLoaded[subSessionId]` via reducer; UI renders immediately.
     */
    loadSubagentHistory: (subSessionId: string) => Promise<void>;
    /**
     * Stop one running subagent (subagent.abort) without aborting the session's
     * turn. The settled outcome arrives through the normal paths (tool_end for a
     * sync child, SUBAGENT_SETTLED with outcome "aborted" for a background one).
     */
    abortSubagent: (subSessionId: string) => Promise<void>;

    /** Write askUser user-selected answers + questions, read by sendPrompt at injection time. */
    setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => void;
}

/**
 * Whether a send may still hand off to the other delivery path.
 *
 * sendPrompt and steerPrompt each degrade into the other: a prompt rejected with
 * `session_busy` becomes a steer, and a steer that reports `idle` becomes a
 * prompt. Both conditions are real server states rather than stale reads, so a
 * session whose runs start and stop quickly (a queue draining, say) can flip
 * between them repeatedly — nothing about the handoff converges on its own.
 * The first hop passes "exhausted" so the second cannot hop again; it surfaces
 * an error the user can retry instead.
 */
type SteerHandoff = "allowed" | "exhausted";

/** A chatty sidecar must not grow the list without bound; the oldest fall off. */
const MAX_NOTIFICATIONS = 50;
/**
 * Identical text arriving within this window merges into the head row instead of
 * appending a new one. The old error banner showed only the latest message, so
 * without this a per-tick `[error]` line would fill the whole list with copies.
 */
const COALESCE_WINDOW_MS = 10_000;

export function useWorkspaces(client: TacoClient): UseWorkspacesApi {
    const { t } = useT();
    const [workspaces, dispatchWs] = useReducer(workspacesReducer, {});
    // Active cwd is read from desktop.json (via the IPC) inside initFromStorage;
    // the lazy initializer can only return a synchronous value, so we seed with
    // the empty string and let initFromStorage set the real value once the
    // read resolves. The first paint uses the empty placeholder; initFromStorage
    // runs in a mount effect so React commits the real value before the user
    // can interact with the workspace selector.
    const [activeCwd, setActiveCwd] = useState<string>("");
    const [notifications, setNotifications] = useState<AppNotification[]>([]);
    // Per-instance id source. A module-level counter would be shared by every
    // mounted hook (and survive HMR), so two lists could hand out the same id.
    const notificationSeqRef = useRef(0);
    const pushNotification = useCallback((text: string, opts: PushNotificationOptions = {}) => {
        const { kind = "generic", source = "client", level = "error" } = opts;
        const at = Date.now();
        // Allocated eagerly so the state updater stays pure — React may invoke
        // it more than once per dispatch (StrictMode double-render).
        notificationSeqRef.current += 1;
        const id = notificationSeqRef.current;
        setNotifications((prev) => {
            const head = prev[0];
            if (
                head &&
                head.text === text &&
                head.approval?.requestId === opts.approval?.requestId &&
                head.kind === kind &&
                head.source === source &&
                head.level === level &&
                at - head.at < COALESCE_WINDOW_MS
            ) {
                // Same message, still repeating: bump the head row instead of
                // appending a duplicate. `at` moves so the row's clock reads as
                // "still happening", and a stream that keeps repeating stays one
                // row for as long as it does. The id is kept, so the bell treats
                // a repeat as the row it already announced, not a new arrival.
                return [{ ...head, at, count: head.count + 1 }, ...prev.slice(1)];
            }
            const entry: AppNotification = {
                id,
                text,
                at,
                count: 1,
                kind,
                source,
                level,
                ...(opts.approval ? { approval: opts.approval } : {}),
            };
            return [entry, ...prev].slice(0, MAX_NOTIFICATIONS);
        });
    }, []);
    const dismissNotification = useCallback((id: number) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, []);
    const clearNotifications = useCallback(() => setNotifications([]), []);

    // workspacesRef — for read-after-write paths (attachSession / switchWorkspace, etc.).
    const workspacesRef = useRef<Record<string, WorkspaceState>>(workspaces);
    /**
     * In-flight flag for the lazy-create branch of sendPrompt. Set to true the
     * moment the empty `sessionCreate` fires, cleared on success/failure. A
     * second Enter before the first `sessionCreate` resolves reads
     * `ws?.activeSession === undefined` and would otherwise take the lazy
     * branch again — creating two server sessions. With this flag, the second
     * send is dropped silently (the user sees their input still in the box,
     * no bubble added) until the first finishes.
     */
    const pendingCreateRef = useRef(false);
    /**
     * Session ids the user aborted via abortPrompt. The in-flight sessionPrompt
     * RPC rejects once the abort lands ("session.prompt aborted") — that
     * rejection is the expected outcome of the user's own Stop click, so
     * sendPrompt's catch suppresses the notification for it. Keyed by sid: the
     * user may switch sessions between abort and rejection.
     */
    const abortRequestedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        workspacesRef.current = workspaces;
    }, [workspaces]);

    const settings = useSessionSettings({
        client,
        activeCwd,
        activeSession: workspaces[activeCwd]?.activeSession,
        pushNotification,
    });
    // sendPrompt's lazy-create branch awaits sessionCreate before recording the
    // new session's level/model, so it must read the settings API as of
    // await-resolution time rather than through its render-time closure.
    const settingsRef = useRef(settings);
    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    // ── workspace CRUD / lifecycle ──
    const lifecycle = useWorkspaceLifecycle({
        client,
        dispatchWs,
        workspacesRef,
        activeCwd,
        setActiveCwd,
        pushNotification,
    });
    const { refreshSessionList, attachSessionRef } = lifecycle;

    // askUserAnswersRef — holds user-selected answers + questions per pending toolCallId,
    // read by the askUserPending → session.submitAnswers useEffect below.
    const askUserAnswersRef = useRef<Record<string, AskUserPayload>>({});
    const prevAskUserPendingRef = useRef<Record<string, true>>({});

    // Watch askUserPending: when pending disappears (= user selected), submit the structured
    // answers to sidecar via session.submitAnswers RPC. Sidecar constructs the
    // <ask_user_context> and injects it into the user message; the client stays agnostic
    // of the wire format (JSON / tag names) — sidecar owns that.
    useEffect(() => {
        const ws = workspaces[activeCwd];
        if (!ws?.activeSession) return;
        const pending = ws.askUserPending ?? {};
        for (const toolCallId of Object.keys(prevAskUserPendingRef.current)) {
            if (!(toolCallId in pending)) {
                // Left pending state: user selected, submit the answers.
                const payload = askUserAnswersRef.current[toolCallId];
                if (payload && Object.keys(payload.answers).length > 0) {
                    const toolName = payload.toolName ?? "askUser";
                    client
                        .sessionSubmitAnswers(
                            asWorkspaceId(activeCwd),
                            asSessionId(ws.activeSession),
                            toolCallId,
                            payload.answers,
                            toolName,
                        )
                        .catch((err) => {
                            // The answers are gone once we leave pending state, so a
                            // silent failure loses the user's input with no signal at
                            // all. Surface it — they can retype into the composer.
                            console.error("[taco] submitAnswers failed", err);
                            pushNotification(
                                `Submitting your answer failed: ${(err as Error).message}`,
                            );
                        });
                }
                delete askUserAnswersRef.current[toolCallId];
            }
        }
        prevAskUserPendingRef.current = pending;
    }, [workspaces, activeCwd, client, pushNotification]);

    const activeWs = workspaces[activeCwd];

    // ── helpers ──
    const dispatch = useCallback(
        (action: SidecarAction) => {
            if (action.type === "EVENT") {
                dispatchWs({
                    type: "APPLY_EVENT",
                    cwd: action.cwd,
                    sid: action.sid,
                    suppressedThinking: settings.isThinkingSuppressed(action.sid),
                    now: Date.now(),
                    ev: action.ev,
                });
            } else if (action.type === "CHILD_MESSAGE_EVENT") {
                // Child session realtime events — the child harness doesn't expose a thinking
                // level config, treat as enabled (not suppressed), matching parent default.
                dispatchWs({
                    type: "CHILD_MESSAGE_EVENT",
                    cwd: action.cwd,
                    subSessionId: action.sid,
                    suppressedThinking: false,
                    now: Date.now(),
                    ev: action.ev,
                });
            } else if (action.type === "SUBAGENT_SPAWNED") {
                dispatchWs({
                    type: "SUBAGENT_SPAWNED",
                    cwd: action.cwd,
                    parentSessionId: action.parentSessionId,
                    parentToolCallId: action.parentToolCallId,
                    subSessionId: action.subSessionId,
                    agentType: action.agentType,
                });
            } else if (action.type === "SUBAGENT_SETTLED") {
                dispatchWs({
                    type: "SUBAGENT_SETTLED",
                    cwd: action.cwd,
                    parentToolCallId: action.parentToolCallId,
                    outcome: action.outcome,
                });
            } else if (action.type === "ATTACHED") {
                dispatchWs({ type: "ATTACHED_PUSH", cwd: action.cwd, sid: action.sid });
            } else if (action.type === "COMMAND_PERMISSION_REQUESTED") {
                if (
                    action.cwd.startsWith(IM_CWD_PREFIX) &&
                    !workspacesRef.current[action.cwd]?.pendingCommandPermissions[
                        action.request.requestId
                    ]
                ) {
                    pushNotification(t("session.imApprovalRequired"), {
                        source: "sidecar",
                        level: "warn",
                        approval: {
                            cwd: action.cwd,
                            sessionId: action.request.displaySessionId ?? action.sid,
                            requestId: action.request.requestId,
                        },
                    });
                }
                dispatchWs({
                    type: "COMMAND_PERMISSION_REQUESTED",
                    cwd: action.cwd,
                    sid: action.sid,
                    request: action.request,
                });
            } else if (action.type === "COMMAND_PERMISSION_RESOLVED") {
                setNotifications((prev) =>
                    prev.filter((n) => n.approval?.requestId !== action.requestId),
                );
                dispatchWs({
                    type: "COMMAND_PERMISSION_RESOLVED",
                    cwd: action.cwd,
                    requestId: action.requestId,
                });
            } else if (action.type === "SIDECAR_RESTARTED") {
                dispatchWs({ type: "SIDECAR_RESTARTED", cwd: action.cwd });
                // The replacement daemon starts with no attached sessions —
                // re-attach the active one so per-session RPCs (setModel,
                // setLevel, prompt) work again. Fires after the new daemon's
                // initialize handshake, so the attach lands on a serving
                // process. Without this, optimistic UI updates roll back on
                // the first "session not attached" error.
                const sid = workspacesRef.current[action.cwd]?.activeSession;
                if (sid) {
                    void attachSessionRef.current(action.cwd, sid).catch((err: unknown) => {
                        console.error(
                            "[taco] re-attach after sidecar restart failed",
                            action.cwd,
                            err,
                        );
                    });
                }
            } else if (action.type === "ERROR") {
                // A `session.error` push — the sidecar's own report, not the
                // reply to a click, so it goes to the bell without a toast.
                pushNotification(action.message, { source: "sidecar" });
                if (action.cwd && action.sid) {
                    const sysMsg: UiMessage = {
                        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        kind: "system",
                        text: action.message,
                        ts: Date.now(),
                    };
                    dispatchWs({
                        type: "APPEND_SYSTEM",
                        cwd: action.cwd,
                        sid: action.sid,
                        msg: sysMsg,
                    });
                }
            } else if (action.type === "ASKUSER_ANSWERED") {
                // After askUserView user selection, dispatch ASKUSER_ANSWERED to clear pending.
                dispatchWs({
                    type: "ASKUSER_ANSWERED",
                    cwd: action.cwd,
                    toolCallId: action.toolCallId,
                    answers: action.answers,
                });
            } else if (action.type === "TASKS_UPDATED") {
                // Sidecar pushes the latest list snapshot on every successful task-tool path
                // (tasks.updated push). Drives TaskPanel realtime refresh.
                dispatchWs({
                    type: "TASKS_UPDATED",
                    cwd: action.cwd,
                    sid: action.sid,
                    active: action.active,
                    history: action.history,
                });
            } else if (action.type === "PLAN_STATE_UPDATED") {
                dispatchWs({
                    type: "PLAN_STATE_UPDATED",
                    cwd: action.cwd,
                    sid: action.sid,
                    active: action.active,
                    currentSlug: action.currentSlug,
                });
            } else if (action.type === "SESSION_RENAMED") {
                dispatchWs({
                    type: "SESSION_RENAMED",
                    cwd: action.cwd,
                    sid: action.sid,
                    name: action.name,
                });
            }
            // Note: answers only land in the ref, read by the useEffect.
        },
        // attachSessionRef is a stable ref object; its .current is read at call
        // time on purpose, so it must not be a dependency.
        [settings, attachSessionRef, pushNotification, t],
    );

    const beginPendingNewSession = useCallback((cwd: string): void => {
        // Pure client-side state reset — the new session id is allocated by the server
        // when the first real send reaches sendPrompt's `!ws?.activeSession` branch
        // (it calls sessionCreate with initialPrompt and reads sessionId from the
        // response). Until that send, the workspace has no active session and the
        // session list / file system stay untouched.
        // Reset the in-flight create guard too: if the abandoned session's create
        // chain is still mid-flight, pendingCreateRef stays true and the new
        // session's first send is silently dropped. BEGIN_PENDING_NEW_SESSION is
        // the explicit "abandon the current pending session" signal, so the guard
        // must not carry over.
        pendingCreateRef.current = false;
        settingsRef.current.clearStagedModel(); // belongs to the abandoned session
        dispatchWs({ type: "BEGIN_PENDING_NEW_SESSION", cwd });
    }, []);

    async function sendPrompt(
        text: string,
        images?: ImageInput[],
        handoff: SteerHandoff = "allowed",
    ): Promise<boolean> {
        const trimmed = text.trim();
        // Allow image-only prompts (text empty but attachments present) — they go through the
        // full sessionCreate / sessionPrompt path (sidecar already supports params.initialPrompt ?? "").
        // The only return-false condition is text AND images both empty (nothing to send).
        if (!trimmed && (!images || images.length === 0)) return false;
        const cwd = activeCwd;
        const ws = workspacesRef.current[cwd];
        const uiLocale = getGlobalConfig().client.uiLanguage;
        if (!ws?.activeSession) {
            // Double-Enter race: a second Enter before the first sessionCreate
            // resolves would read ws.activeSession === undefined again and
            // take this lazy branch, creating two server sessions. Bail out
            // silently — the user's text stays in the input box. The guard is
            // held until the turn settles: workspacesRef only catches up with
            // ADD_SESSION on the next render, so releasing it right after the
            // create would reopen the same window.
            if (pendingCreateRef.current) return false;
            pendingCreateRef.current = true;
            try {
                // Optimistic user message: the user sees their input immediately
                // while the session is being created. When the server's
                // message_end(user) push arrives, applyEventToMessages replaces
                // this entry with the server-timestamped one (matched by text).
                const now = Date.now();
                const optimisticUserMsg: UiMessage = {
                    id: `optimistic-user-${now}`,
                    kind: "user",
                    text: trimmed,
                    ts: now,
                    ...(images && images.length > 0 ? { images } : {}),
                };
                dispatchWs({ type: "APPEND_USER", cwd, msg: optimisticUserMsg });

                // initialModel was staged while this session had no id yet
                // (fresh-session pre-send). The server attaches with it, and
                // adoptNewSession records both under the allocated id so the
                // menus keep showing them once the session exists.
                const defaults = settingsRef.current.newSessionDefaults();
                const initialModel = defaults.initialModel;
                let createdSessionId: string;
                try {
                    // Two-step create: allocate the session id first (no prompt),
                    // then deliver the prompt through the same path an existing
                    // session uses. activeSession is set before the LLM starts, so
                    // the reducer's APPLY_EVENT guard lets the streaming middle
                    // (tool calls, thinking deltas) through.
                    const created = await client.sessionCreate({
                        workspace: asWorkspaceId(cwd),
                        thinkingLevel: defaults.initialLevel,
                    });
                    createdSessionId = created.sessionId;
                    settingsRef.current.adoptNewSession(created.sessionId, defaults);
                    dispatchWs({
                        type: "ADD_SESSION",
                        cwd,
                        session: {
                            id: created.sessionId,
                            createdAt: new Date().toISOString(),
                            filePath: created.filePath,
                        },
                        makeActive: true,
                    });
                } catch (err) {
                    console.error("[taco] sessionCreate failed", err);
                    pushNotification(`Prompt failed: ${(err as Error).message}`);
                    return false;
                }
                return await deliverPrompt(
                    cwd,
                    createdSessionId,
                    text,
                    trimmed,
                    images,
                    uiLocale,
                    handoff,
                    initialModel ?? undefined,
                );
            } finally {
                pendingCreateRef.current = false;
            }
        }
        return deliverPrompt(cwd, ws.activeSession, text, trimmed, images, uiLocale, handoff);
    }

    /**
     * Deliver one prompt to a session that already exists on the server and
     * settle the UI around the outcome. Shared by the first message of a new
     * session and every later one: a failed turn never deletes the session,
     * because by the time `session.prompt` fails the user's message is already
     * on disk. Removing a session is the user's call (`deleteSession`), not a
     * side effect of a turn ending badly — a Stop click rejects this RPC too.
     */
    async function deliverPrompt(
        cwd: string,
        promptSid: string,
        text: string,
        trimmed: string,
        images: ImageInput[] | undefined,
        uiLocale: SupportedLocale | undefined,
        handoff: SteerHandoff,
        model?: { provider: string; id: string },
    ): Promise<boolean> {
        // Immediate UI feedback: move the current session to top before the
        // server turn completes. The real updatedAt will be overwritten by the
        // subsequent refreshSessionList once the turn ends.
        dispatchWs({
            type: "BUMP_SESSION_TIME",
            cwd,
            sid: promptSid,
            updatedAt: new Date().toISOString(),
        });
        dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: true });
        try {
            const reply = (
                await client.sessionPrompt(
                    asWorkspaceId(cwd),
                    asSessionId(promptSid),
                    trimmed,
                    images,
                    uiLocale,
                    model,
                )
            ).assistantMessage;
            // Auto-title is persisted inside server-side session.prompt and invalidateListCache'd,
            // so refreshing this workspace's session list now must read the latest name. List-only
            // refresh, no attach — using reloadAllWorkspaces would force-attach sessions[0] and swap
            // the user's in-conversation history panel to the newest session (dropping this turn's
            // reply). Refreshing after sessionPrompt returns avoids racing the server's title write
            // (a concurrent fire could read a stale title).
            void refreshSessionList(cwd);
            // The turn completed, so no abort-induced rejection is coming for it.
            // Dropping the marker here is what keeps it from outliving this turn:
            // an abort that lands just as the run finishes resolves the RPC
            // instead of rejecting it, and a marker left behind would swallow the
            // notification for this session's next genuine prompt failure.
            abortRequestedRef.current.delete(promptSid);
            if (reply) {
                dispatchWs({
                    type: "APPEND_ASSISTANT_FINAL",
                    cwd,
                    sid: promptSid,
                    reply,
                });
                // Clear pending for the source session even when it is not active.
                // APPEND_ASSISTANT_FINAL skips non-active sessions (messages unchanged),
                // so we must dispatch SET_PENDING here to unblock the send/stop button.
                dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: false });
            } else {
                dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: false });
            }
            return true;
        } catch (err) {
            console.error("[taco] sessionPrompt failed", err);
            // User-initiated abort rejects the in-flight prompt RPC — that is
            // the expected Stop outcome, not a failure to report. (Checked
            // first: a session_busy from a concurrent turn should not consume
            // the marker.)
            if (abortRequestedRef.current.delete(promptSid)) {
                dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: false });
                return false;
            }
            // session_busy = the server has a run in flight for this session. The
            // turn-start failed, but the text can still land as an in-run steer —
            // degrade instead of surfacing an error the user can't act on. Only
            // once: see SteerHandoff.
            // Pending deliberately stays set: session_busy means a run really is
            // in flight, and its run_end is what clears the slot.
            if ((err as { code?: string }).code === ErrorCodes.SessionBusy) {
                if (handoff === "allowed") return steerPrompt(text, images, "exhausted");
                pushNotification("Prompt failed: the session is busy; try again");
                return false;
            }
            pushNotification(`Prompt failed: ${(err as Error).message}`);
            dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: false });
            return false;
        }
    }

    async function steerPrompt(
        text: string,
        images?: ImageInput[],
        handoff: SteerHandoff = "allowed",
    ): Promise<boolean> {
        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) return false;
        const cwd = activeCwd;
        const ws = workspacesRef.current[cwd];
        const uiLocale = getGlobalConfig().client.uiLanguage;
        const steerSid = ws?.activeSession;
        if (!steerSid) return false;
        // A queued row only — deliberately no optimistic user bubble. A queued
        // message is not yet part of the conversation: pi writes it to the lane
        // inbox and may never consume it (the user aborts, or cancels the row),
        // in which case a bubble would claim the message was sent when it never
        // reached the model. The server's message_end push adds the bubble at
        // the moment the run actually consumes the entry.
        const queuedItem: QueuedUiItem = {
            id: `optimistic-queued-${Date.now()}`,
            kind: "steer",
            text: trimmed,
            optimistic: true,
        };
        dispatchWs({ type: "APPEND_QUEUED", cwd, sid: steerSid, item: queuedItem });
        try {
            const result = await client.sessionSteer(
                asWorkspaceId(cwd),
                asSessionId(steerSid),
                trimmed,
                images,
                uiLocale,
            );
            if (result.mode !== "idle") return true;
            // The run ended between the composer's steer and the server's check,
            // so the entry would sit unconsumed until the next prompt. Hand back
            // to the prompt path — but only once, see SteerHandoff.
            if (handoff === "exhausted") {
                pushNotification("Steer failed: the session stopped accepting input; try again");
                return false;
            }
            return sendPrompt(text, images, "exhausted");
        } catch (err) {
            console.error("[taco] sessionSteer failed", err);
            pushNotification(`Steer failed: ${(err as Error).message}`);
            return false;
        } finally {
            // The optimistic row's job ends when the RPC settles: on success the
            // server's queue_update has already delivered the real row (pi emits
            // it from inside the lane command, before this response), and on
            // failure there is nothing to show.
            dispatchWs({ type: "REMOVE_QUEUED", cwd, sid: steerSid, id: queuedItem.id });
        }
    }

    async function cancelQueued(entryId: string): Promise<void> {
        const cwd = activeCwd;
        const ws = workspacesRef.current[cwd];
        const sid = ws?.activeSession;
        if (!sid) return;
        // Optimistic removal; the server's queue_update is the authority and
        // re-adds the row if the entry turned out to be already consumed. Capture
        // the row first so a failed RPC can restore it.
        const item = (ws.queuedBySessionId[sid] ?? []).find((q) => q.id === entryId);
        dispatchWs({ type: "REMOVE_QUEUED", cwd, sid, id: entryId });
        try {
            await client.sessionCancelQueued(asWorkspaceId(cwd), asSessionId(sid), entryId);
        } catch (err) {
            console.error("[taco] sessionCancelQueued failed", err);
            pushNotification(`Cancel failed: ${(err as Error).message}`);
            if (item) dispatchWs({ type: "APPEND_QUEUED", cwd, sid, item });
        }
    }

    async function abortPrompt(): Promise<string[]> {
        const cwd = activeCwd;
        const ws = workspacesRef.current[cwd];
        if (!ws?.activeSession) return [];
        // Mark before the RPC: the in-flight sessionPrompt's rejection can land
        // before sessionAbort resolves, and sendPrompt's catch must already know
        // this abort was user-initiated.
        abortRequestedRef.current.add(ws.activeSession);
        try {
            const result = await client.sessionAbort(
                asWorkspaceId(cwd),
                asSessionId(ws.activeSession),
            );
            // Discard order isn't preserved across the two queues server-side;
            // steer went in first and reads more naturally restored first.
            return [...(result.discardedSteer ?? []), ...(result.discardedFollowUp ?? [])];
        } catch (err) {
            console.error("[taco] sessionAbort failed", err);
            // The abort never landed, so no abort-induced prompt rejection is
            // coming — drop the marker or a later genuine failure would be
            // misclassified as user-initiated.
            abortRequestedRef.current.delete(ws.activeSession);
            pushNotification(`Abort failed: ${(err as Error).message}`);
            return [];
        } finally {
            dispatchWs({ type: "SET_PENDING", cwd, sid: ws.activeSession, pending: false });
        }
    }

    async function loadSubagentHistory(subSessionId: string): Promise<void> {
        const cwd = activeCwd;
        try {
            const hist = await client.sessionHistory(asWorkspaceId(cwd), asSessionId(subSessionId));
            const msgs = historyToUiMessages(
                hist.entries as Parameters<typeof historyToUiMessages>[0],
            );
            dispatchWs({ type: "LOAD_SUBAGENT_HISTORY", cwd, subSessionId, messages: msgs });
        } catch (err) {
            console.error("[taco] subagent history pull failed", subSessionId, err);
            pushNotification(`Subagent history failed: ${(err as Error).message}`);
        }
    }

    async function abortSubagent(subSessionId: string): Promise<void> {
        try {
            // "not_running" needs no surface: the child already settled, and
            // its terminal state renders through the normal paths.
            await client.subagentAbort(asWorkspaceId(activeCwd), asSessionId(subSessionId));
        } catch (err) {
            console.error("[taco] subagentAbort failed", subSessionId, err);
            pushNotification(`Stop subagent failed: ${(err as Error).message}`);
        }
    }

    return {
        workspaces,
        activeCwd,
        activeWs,
        sessionLevels: settings.sessionLevels,
        notifications,
        defaultCwdSettled: lifecycle.defaultCwdSettled,
        dispatch,
        dispatchWs,
        pushNotification,
        dismissNotification,
        clearNotifications,
        initFromStorage: lifecycle.initFromStorage,
        reloadAllWorkspaces: lifecycle.reloadAllWorkspaces,
        loadMoreSessions: lifecycle.loadMoreSessions,
        openWorkspace: lifecycle.openWorkspace,
        browseAndOpen: lifecycle.browseAndOpen,
        openImConversation: lifecycle.openImConversation,
        switchWorkspace: lifecycle.switchWorkspace,
        attachSession: lifecycle.attachSession,
        restoreSessionSnapshot: lifecycle.restoreSessionSnapshot,
        deleteSession: lifecycle.deleteSession,
        renameSession: lifecycle.renameSession,
        beginPendingNewSession,
        sendPrompt,
        steerPrompt,
        cancelQueued,
        abortPrompt,
        setSessionModel: settings.setSessionModel,
        setSessionLevel: settings.setSessionLevel,
        activeModel: settings.activeModel,
        activeLevel: settings.activeLevel,
        loadSubagentHistory,
        abortSubagent,
        setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => {
            askUserAnswersRef.current[toolCallId] = payload;
        },
    };
}
