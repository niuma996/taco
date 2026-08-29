/**
 * useWorkspaces — workspace / session state machine, persistence, and CRUD.
 *
 * Domain state lives in the workspaces reducer; per-session thinking level and
 * model are delegated to useSessionSettings. errorBanner is a plain useState,
 * kept out of the reducer so error display does not pollute business state.
 * input / pendingDeleteSession / confirmNewSession stay in App.tsx (UI state).
 */

import type { AgentMessage, ImageInput, ThinkingLevel } from "@taco-ai/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ModelSelection } from "../components/settings/ModelPicker";
import { historyToUiMessages, type UiMessage } from "../lib/chat/chatUtils";
import {
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../lib/chat/workspaceReducer";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { getGlobalConfig } from "../lib/globalConfig";
import type { SnapshotRecovery } from "../lib/sessionPushProcessor";
import { useToast } from "./primitives/useToast";
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
    errorBanner: string | null;

    // ── top-level lifecycle ──
    /** Handle SidecarAction — entry paired with useSidecarStream's onAction. */
    dispatch: (action: SidecarAction) => void;
    /** Dispatch WorkspaceAction directly (for view components to fire non-push actions, e.g. history expand fetch). */
    dispatchWs: (action: WorkspaceAction) => void;
    /** Error banner setter (kept out of workspaces reducer — error display is not business state). */
    setErrorBanner: (msg: string | null) => void;

    // ── workspace CRUD ──
    initFromStorage: () => Promise<void>;
    /** Called after sidecar restart: refetch every workspace's sessions and attach the first. */
    reloadAllWorkspaces: () => Promise<void>;
    /** Sidebar "load more" — appends the next page using the current cursor. */
    loadMoreSessions: (cwd: string) => Promise<void>;
    /**
     * Resolve `true` when the workspace was ensured on the sidecar and is
     * now the active one; `false` if validation failed or the load/switch
     * step threw. Errors are already surfaced via toast + error banner — the
     * boolean is for callers (e.g. onboarding) that need to gate the next
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
    openImConversation: (cwd: string, sid: string) => Promise<void>;
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
     */
    sendPrompt: (text: string, images?: ImageInput[]) => Promise<boolean>;
    abortPrompt: () => Promise<void>;

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

    /** Write askUser user-selected answers + questions, read by sendPrompt at injection time. */
    setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => void;
}

export function useWorkspaces(client: TacoClient): UseWorkspacesApi {
    const [workspaces, dispatchWs] = useReducer(workspacesReducer, {});
    // Active cwd is read from desktop.json (via the IPC) inside initFromStorage;
    // the lazy initializer can only return a synchronous value, so we seed with
    // the empty string and let initFromStorage set the real value once the
    // read resolves. The first paint uses the empty placeholder; initFromStorage
    // runs in a mount effect so React commits the real value before the user
    // can interact with the workspace selector.
    const [activeCwd, setActiveCwd] = useState<string>("");
    const [errorBanner, setErrorBanner] = useState<string | null>(null);
    // showToast is used for non-blocking errors on paths like openWorkspace, replacing window.alert.
    // ToastProvider wraps the whole App in main.tsx, so useWorkspaces always runs inside the provider.
    const { show: showToast } = useToast();

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
    useEffect(() => {
        workspacesRef.current = workspaces;
    }, [workspaces]);

    const settings = useSessionSettings({
        client,
        activeCwd,
        activeSession: workspaces[activeCwd]?.activeSession,
        setErrorBanner,
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
        setErrorBanner,
        showToast,
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
                            activeCwd,
                            ws.activeSession,
                            toolCallId,
                            payload.answers,
                            toolName,
                        )
                        .catch((err) => {
                            // The answers are gone once we leave pending state, so a
                            // silent failure loses the user's input with no signal at
                            // all. Surface it — they can retype into the composer.
                            console.error("[taco] submitAnswers failed", err);
                            setErrorBanner(
                                `Submitting your answer failed: ${(err as Error).message}`,
                            );
                        });
                }
                delete askUserAnswersRef.current[toolCallId];
            }
        }
        prevAskUserPendingRef.current = pending;
    }, [workspaces, activeCwd, client]);

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
            } else if (action.type === "ATTACHED") {
                dispatchWs({ type: "ATTACHED_PUSH", cwd: action.cwd, sid: action.sid });
            } else if (action.type === "COMMAND_PERMISSION_REQUESTED") {
                dispatchWs({
                    type: "COMMAND_PERMISSION_REQUESTED",
                    cwd: action.cwd,
                    sid: action.sid,
                    request: action.request,
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
                setErrorBanner(action.message);
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
                // First-ever snapshot for this sid (typical: taskCreate's first push) →
                // force-expand TaskPanel regardless of prior manual collapse. TaskPanel clears
                // the flag via CONSUMED so old-snapshot re-pushes don't keep popping it.
                const prev = workspacesRef.current[action.cwd];
                if (prev && prev.taskSnapshotsBySessionId[action.sid] === undefined) {
                    dispatchWs({
                        type: "TASK_PANEL_FORCE_EXPAND",
                        cwd: action.cwd,
                    });
                }
            } else if (action.type === "PLAN_STATE_UPDATED") {
                dispatchWs({
                    type: "PLAN_STATE_UPDATED",
                    cwd: action.cwd,
                    sid: action.sid,
                    active: action.active,
                    currentSlug: action.currentSlug,
                });
            }
            // Note: answers only land in the ref, read by the useEffect.
        },
        // attachSessionRef is a stable ref object; its .current is read at call
        // time on purpose, so it must not be a dependency.
        [settings, attachSessionRef],
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

    async function sendPrompt(text: string, images?: ImageInput[]): Promise<boolean> {
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
            // silently — the user's text stays in the input box.
            if (pendingCreateRef.current) return false;
            pendingCreateRef.current = true;
            // Hoisted out of the try: the id only exists once sessionCreate
            // resolves, but every exit path after SET_PENDING(true) below has to
            // be able to undo that pending slot — including the catch.
            let createdSessionId: string | undefined;
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
                // Two-step create: allocate the session id first (no prompt), then
                // send the prompt through the same blocking-but-push-friendly path
                // that sessionPrompt uses for existing sessions. This keeps the
                // streaming middle (tool calls, thinking deltas) visible because
                // activeSession is set before the LLM starts — the reducer's
                // APPLY_EVENT guard (activeSession !== action.sid) lets push
                // events through instead of dropping them.
                const created = await client.sessionCreate({
                    workspace: cwd,
                    thinkingLevel: defaults.initialLevel,
                });
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
                createdSessionId = created.sessionId;
                dispatchWs({ type: "SET_PENDING", cwd, sid: created.sessionId, pending: true });
                let reply: AgentMessage | null = null;
                try {
                    reply = (
                        await client.sessionPrompt(
                            cwd,
                            created.sessionId,
                            trimmed,
                            images,
                            uiLocale,
                            initialModel ?? undefined,
                        )
                    ).assistantMessage;
                } catch (promptErr) {
                    // sessionPrompt failed AFTER the empty session was already
                    // persisted server-side (sessionLifecycle.ts:84-91 always
                    // runs repo.create). Best-effort cleanup so we don't leave
                    // a phantom session in the sidebar or on disk.
                    try {
                        await client.sessionDelete(cwd, created.sessionId);
                    } catch (cleanupErr) {
                        console.error(
                            "[taco] cleanup after sessionPrompt failure failed",
                            cleanupErr,
                        );
                    }
                    throw promptErr;
                }
                if (reply) {
                    dispatchWs({
                        type: "APPEND_ASSISTANT_FINAL",
                        cwd,
                        sid: created.sessionId,
                        reply,
                    });
                }
                // Always clear pending explicitly, mirroring the existing-session
                // branch below. APPEND_ASSISTANT_FINAL bails out when this sid is
                // no longer activeSession, so relying on it alone leaks a stuck
                // "running" dot whenever the user starts another session while
                // this turn is still in flight (long tool / subagent runs).
                dispatchWs({
                    type: "SET_PENDING",
                    cwd,
                    sid: created.sessionId,
                    pending: false,
                });
                // Background refresh pulls the server-persisted auto-title and
                // authoritative updatedAt into the sidebar — non-blocking, the
                // optimistic row above is already correct.
                void refreshSessionList(cwd);
                return true;
            } catch (err) {
                console.error("[taco] sessionCreate/sessionPrompt failed", err);
                setErrorBanner(`Prompt failed: ${(err as Error).message}`);
                // sessionCreate may already have set this session's pending slot
                // before the failure. Nothing else will ever clear it — the turn
                // never started, so no turn_end / agent_end frame is coming — so
                // the composer would stay disabled until the app restarts.
                if (createdSessionId) {
                    dispatchWs({ type: "SET_PENDING", cwd, sid: createdSessionId, pending: false });
                }
                return false;
            } finally {
                pendingCreateRef.current = false;
            }
        }
        // Capture this turn's sid: clear must land on the session that started the turn, not on
        // whatever activeSession is at clear time.
        const promptSid = ws.activeSession;
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
                await client.sessionPrompt(cwd, ws.activeSession, trimmed, images, uiLocale)
            ).assistantMessage;
            // Auto-title is persisted inside server-side session.prompt and invalidateListCache'd,
            // so refreshing this workspace's session list now must read the latest name. List-only
            // refresh, no attach — using reloadAllWorkspaces would force-attach sessions[0] and swap
            // the user's in-conversation history panel to the newest session (dropping this turn's
            // reply). Refreshing after sessionPrompt returns avoids racing the server's title write
            // (a concurrent fire could read a stale title).
            void refreshSessionList(cwd);
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
            setErrorBanner(`Prompt failed: ${(err as Error).message}`);
            dispatchWs({ type: "SET_PENDING", cwd, sid: promptSid, pending: false });
            return false;
        }
    }

    async function abortPrompt(): Promise<void> {
        const cwd = activeCwd;
        const ws = workspacesRef.current[cwd];
        if (!ws?.activeSession) return;
        try {
            await client.sessionAbort(cwd, ws.activeSession);
        } catch (err) {
            console.error("[taco] sessionAbort failed", err);
            setErrorBanner(`Abort failed: ${(err as Error).message}`);
        } finally {
            dispatchWs({ type: "SET_PENDING", cwd, sid: ws.activeSession, pending: false });
        }
    }

    async function loadSubagentHistory(subSessionId: string): Promise<void> {
        const cwd = activeCwd;
        try {
            const hist = await client.sessionHistory(cwd, subSessionId);
            const msgs = historyToUiMessages(
                hist.entries as Parameters<typeof historyToUiMessages>[0],
            );
            dispatchWs({ type: "LOAD_SUBAGENT_HISTORY", cwd, subSessionId, messages: msgs });
        } catch (err) {
            console.error("[taco] subagent history pull failed", subSessionId, err);
            setErrorBanner(`Subagent history failed: ${(err as Error).message}`);
        }
    }

    return {
        workspaces,
        activeCwd,
        activeWs,
        sessionLevels: settings.sessionLevels,
        errorBanner,
        dispatch,
        dispatchWs,
        setErrorBanner,
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
        abortPrompt,
        setSessionModel: settings.setSessionModel,
        setSessionLevel: settings.setSessionLevel,
        activeModel: settings.activeModel,
        activeLevel: settings.activeLevel,
        loadSubagentHistory,
        setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => {
            askUserAnswersRef.current[toolCallId] = payload;
        },
    };
}
