/**
 * useWorkspaces — workspace / session state machine, persistence, thinking level, and CRUD.
 *
 * workspaces and sessionLevels are two independent useReducers; errorBanner is a separate
 * useState (kept out of reducers so it does not pollute business state).
 * input / pendingDeleteSession / confirmNewSession stay in App.tsx (UI state, not domain state).
 */

import type {
    AgentMessage,
    ImageInput,
    SessionListEntry,
    SessionListResult,
    ThinkingLevel,
} from "@taco-ai/protocol";
import { SESSION_LIST_DEFAULT_LIMIT } from "@taco-ai/protocol";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
    type Dispatch,
    type SetStateAction,
    useCallback,
    useEffect,
    useReducer,
    useRef,
    useState,
} from "react";
import type { ModelSelection } from "../components/settings/ModelPicker";
import { findPendingAskUserIds, historyToUiMessages, type UiMessage } from "../lib/chatUtils";
import { readClientSettings } from "../lib/clientSettings";
import {
    defaultThinkingLevelForNewSession,
    getGlobalConfig,
    loadGlobalConfig,
} from "../lib/globalConfig";
import type { SnapshotRecovery } from "../lib/sessionPushProcessor";
import type { TacoClient } from "../lib/tacoClientTauri.ts";
import {
    createEmptyWorkspace,
    type SessionMeta,
    sortSessionsByUpdatedDesc,
    type WorkspaceAction,
    type WorkspaceState,
    workspacesReducer,
} from "../lib/workspaceReducer";
import {
    initDefaultCwd,
    isValidWorkspaceCwd,
    loadOpenedCwds,
    loadActiveCwd,
    persistActiveCwd,
    persistCwds,
    pruneMissingCwds,
    resolveActiveCwd,
} from "../lib/workspaceStorage";
import type { AskUserPayload } from "./useAskUser";
import { type SidecarAction, sidecarLogListenerReady } from "./useSidecarStream";
import { useToast } from "./useToast";

export type { SessionMeta, WorkspaceState } from "../lib/workspaceReducer";

/** Map a server session entry to client SessionMeta. */
function toSessionMeta(s: SessionListEntry): SessionMeta {
    return {
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        filePath: s.filePath,
        name: s.name,
    };
}

/**
 * Decide whether streaming thinking_* sub-events should be suppressed for
 * this session. Per-session override wins; otherwise fall back to the global
 * default. Used by both the live APPLY_EVENT path and any future "is this
 * session showing thinking" check.
 */
function suppressedThinkingFor(sessionLevels: Record<string, ThinkingLevel>, sid: string): boolean {
    return sessionLevels[sid] !== undefined
        ? sessionLevels[sid] === "off"
        : defaultThinkingLevelForNewSession(getGlobalConfig().global) === "off";
}

/**
 * Optimistic per-session setter: write `next` under `sid`, await `rpc`, and on
 * throw roll back to the previous value if any (else drop the key). Re-throws
 * after rollback so the caller can show its own error UI (banner / toast).
 * Centralizes the hadPrev/prev/destructure dance so model/thinking rollback
 * rules don't drift between call sites.
 */
async function applyOptimistic<K extends string, V>(
    map: Record<K, V>,
    setter: Dispatch<SetStateAction<Record<K, V>>>,
    sid: K,
    next: V,
    rpc: () => Promise<void>,
    label: string,
): Promise<void> {
    const hadPrev = Object.hasOwn(map, sid);
    const prev = map[sid];
    setter((m) => ({ ...m, [sid]: next }));
    try {
        await rpc();
    } catch (err) {
        console.error(`[taco] ${label} failed`, err);
        setter((m) => {
            if (hadPrev) return { ...m, [sid]: prev as V };
            const { [sid]: _drop, ...rest } = m;
            void _drop;
            return rest as Record<K, V>;
        });
        throw err;
    }
}

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
    const [sessionLevels, setSessionLevels] = useState<Record<string, ThinkingLevel>>({});
    const [sessionModels, setSessionModels] = useState<Record<string, ModelSelection>>({});
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
    /** StrictMode double-run guard — see initFromStorage top. */
    const initStartedRef = useRef(false);
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
     * Model picked while no active session exists (a fresh session before its
     * first send). Consumed by sendPrompt's lazy-create branch as the new
     * session's initial model; cleared on create. Without this the ModelMenu
     * change is a no-op — setSessionModel bails on `!activeSession` and the
     * selection is silently dropped. State (not ref) so the ModelMenu re-renders
     * when the staged choice changes.
     */
    const [pendingNewSessionModel, setPendingNewSessionModel] = useState<ModelSelection | null>(
        null,
    );
    const pendingNewSessionModelRef = useRef<ModelSelection | null>(null);
    // Keep the ref in sync so sendPrompt's lazy-create branch reads the staged
    // model without pulling state into its dependency chain.
    useEffect(() => {
        pendingNewSessionModelRef.current = pendingNewSessionModel;
    }, [pendingNewSessionModel]);
    useEffect(() => {
        workspacesRef.current = workspaces;
    }, [workspaces]);

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
                    suppressedThinking: suppressedThinkingFor(sessionLevels, action.sid),
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
        [sessionLevels],
    );

    // ── workspace CRUD ──

    /** Apply a SessionListResult to the reducer. Centralizes the
     *  result→dispatch mapping so initial load, refresh, and load-more share
     *  one place to thread nextCursor + total through. dispatchWs is a
     *  useReducer dispatch, so no deps are needed. */
    const dispatchListResult = useCallback(
        (cwd: string, result: SessionListResult, append: boolean): void => {
            const sessions: SessionMeta[] = (result.sessions ?? []).map(toSessionMeta);
            dispatchWs({
                type: "LOAD_SESSIONS",
                cwd,
                sessions,
                nextCursor: result.nextCursor
                    ? { updatedAt: result.nextCursor.updatedAt, id: result.nextCursor.id }
                    : undefined,
                total: result.total,
                append,
            });
        },
        [],
    );

    const loadWorkspaceSessions = useCallback(
        async (cwd: string): Promise<void> => {
            // The stderr listener must be up before the sidecar can emit a
            // startup line, or the first log is dropped (Tauri's event bus
            // is fire-and-forget). initFromStorage awaits this once at mount;
            // any other code path that calls client.start must do the same.
            await sidecarLogListenerReady;
            // debugMode is read synchronously from localStorage to avoid depending on cache.client
            // (which may still be empty before loadGlobalConfig runs).
            await client.start(cwd, {
                debugMode: readClientSettings().debugMode,
                llmDumpToFile: readClientSettings().llmDumpToFile,
            });
            // Default page size (no full:true) — pagination must actually page on
            // initial load, not fetch every session up front.
            const list = await client.sessionList(cwd);
            dispatchListResult(cwd, list, false);
        },
        [client, dispatchListResult],
    );

    /** Refresh only one workspace's session list (pull latest name etc. for the sidebar).
     * Does NOT `client.start`, attach, or change activeSession. Used after send / rename to
     * refresh sidebar titles. Strictly distinct from `reloadAllWorkspaces` (which force-attaches
     * sessions[0] after a restart) — that one would swap the user's current panel away. */
    const refreshSessionList = useCallback(
        async (cwd: string): Promise<void> => {
            try {
                // Re-fetch as one page sized to what the user has already paged
                // in, so a refresh after a turn keeps an expanded list expanded
                // instead of collapsing it back to the first page.
                const loaded = workspacesRef.current[cwd]?.sessions.length ?? 0;
                const list = await client.sessionList(
                    cwd,
                    loaded > SESSION_LIST_DEFAULT_LIMIT ? { limit: loaded } : undefined,
                );
                dispatchListResult(cwd, list, false);
            } catch (err) {
                console.error("[taco] refreshSessionList failed", cwd, err);
            }
        },
        [client, dispatchListResult],
    );

    const attachSessionInternal = useCallback(
        async (cwd: string, sessionId: string): Promise<void> => {
            try {
                await client.sessionAttach(cwd, sessionId);
            } catch (err) {
                const msg = `Cannot open session: ${(err as Error).message}`;
                console.error("[taco] sessionAttach failed", cwd, sessionId, err);
                setErrorBanner(msg);
                showToast(msg, "error");
                // The session is gone from the server — prune it from the local list
                // so the sidebar no longer shows a dead entry. REMOVE_SESSION's
                // reducer strips this sid's pendingBySessionId slot in the same
                // commit, so the sidebar's "running" dot clears with the row.
                dispatchWs({ type: "REMOVE_SESSION", cwd, sid: sessionId });
                return;
            }
            const hist = await client.sessionHistory(cwd, sessionId);
            const msgs = historyToUiMessages(
                hist.entries as Parameters<typeof historyToUiMessages>[0],
            );
            dispatchWs({
                type: "ATTACH",
                cwd,
                sid: sessionId,
                messages: msgs,
                pendingAskUserIds: findPendingAskUserIds(msgs),
            });
            // tasks / planState fallback — sidecar also pushes on session.attached, but we proactively
            // pull once here to cover push-channel drops. RPC reads sidecar memory directly,
            // independent of the push channel.
            try {
                const r = await client.sessionTasksGet(cwd, sessionId);
                dispatchWs({
                    type: "TASKS_UPDATED",
                    cwd,
                    sid: sessionId,
                    active: r.active,
                    history: r.history,
                });
            } catch {
                /* Older sidecar may lack this RPC — rely on push. */
            }
            try {
                const p = await client.sessionPlanStateGet(cwd, sessionId);
                dispatchWs({
                    type: "PLAN_STATE_UPDATED",
                    cwd,
                    sid: sessionId,
                    active: p.active,
                    currentSlug: p.currentSlug,
                });
            } catch {
                /* Same as above. */
            }
        },
        [client, showToast],
    );

    const attachSession = attachSessionInternal;

    const switchWorkspaceInternal = useCallback(
        async (cwd: string, persist = true): Promise<void> => {
            setActiveCwd(cwd);
            if (persist) persistActiveCwd(cwd);
            dispatchWs({ type: "SET_ACTIVE", cwd });
            const ws = workspacesRef.current[cwd];
            if (ws && ws.messages.length === 0 && !ws.activeSession && ws.sessions[0]) {
                await attachSessionInternal(cwd, ws.sessions[0].id);
            }
        },
        [attachSessionInternal],
    );

    const switchWorkspace = switchWorkspaceInternal;

    const initFromStorage = useCallback(async () => {
        // StrictMode double-run guard: React 18 dev mount effects run twice. client.start is
        // idempotent (ensuredCwds + shared readiness) and already blocks duplicate spawn, but
        // the full init (sessionList / attach / loadGlobalConfig / dispatch) must not repeat.
        // The in-flight ref guarantees a single run.
        if (initStartedRef.current) return;
        initStartedRef.current = true;
        // Block until the stderr listener is up — otherwise startup lines
        // emitted by the sidecar between cmd.spawn and the listener's
        // `await listen(...)` returning are lost. Tauri's event bus is
        // fire-and-forget; there is no replay for late subscribers.
        await sidecarLogListenerReady;
        // Resolve the real default cwd ($TACO_HOME/workspace, created on demand)
        // before reading storage — loadOpenedCwds / resolveActiveCwd fall back to
        // it, and the sync placeholder value points at a path that may not exist.
        await initDefaultCwd();
        // Read opened + active from desktop.json (via the Rust host). The read
        // also runs the one-shot migration from the legacy localStorage keys,
        // so an upgrade-in-place user lands in the same workspaces as before.
        const opened = await pruneMissingCwds(await loadOpenedCwds());
        // loadActiveCwd reads the same desktop.json block (separate IPC call so
        // callers that only need active don't pay for the full opened list).
        const storedActive = await loadActiveCwd();
        // resolveActiveCwd is a pure function: prefers the stored active, then
        // opened[0], then the default cwd. We still validate storedActive
        // against opened because the desktop.json active can outlive a workspace
        // that was dropped during pruning.
        const activeTarget = resolveActiveCwd(
            storedActive && opened.includes(storedActive) ? storedActive : null,
            opened,
        );
        setActiveCwd(activeTarget);
        // Persist the post-prune list back so a workspace that disappeared
        // between sessions does not get carried forward. Failure is logged but
        // non-fatal — the in-memory `opened` already excludes the dropped ones.
        await persistCwds(opened);
        const placeholder: Record<string, WorkspaceState> = {};
        for (const cwd of opened) {
            placeholder[cwd] = createEmptyWorkspace(cwd, cwd === activeTarget);
        }
        dispatchWs({ type: "INIT", workspaces: placeholder });
        // Pull each workspace's session list directly (bypassing loadWorkspaceSessions's dispatch)
        // so Promise.all gives us the real sessions[0] for default attach.
        // workspacesRef depends on a useEffect sync, so reading after await may still see stale.
        //
        // debugMode / llmDumpToFile / theme / uiLanguage are read synchronously
        // from localStorage here on purpose. They are passed into the
        // client.start() options below, which the Rust host forwards to the
        // sidecar's spawn env (TACO_DEBUG_LLM_PAYLOAD) — so the values must
        // be known before sidecar.ensureWorkspace fires. settings.get is a
        // sidecar RPC and cannot run before the sidecar is up; LS is the only
        // pre-spawn read available. (Workspaces, by contrast, have no
        // pre-spawn constraint and moved to desktop.json — see
        // workspaceStorage.ts.)
        const firstSessionByCwd: Record<string, SessionMeta | undefined> = {};
        const settings = readClientSettings();
        // Retry the whole start+sessionList chain when the sidecar isn't ready
        // yet — on a Vite full-page reload (triggered by JSON / non-component
        // file changes), the sidecar process is often still spinning up and
        // hello doesn't arrive before the 10s timeout. Without retries the
        // cwd's sessions stay empty forever because initStartedRef blocks
        // re-entry. Three attempts with 500/1500/3000ms backoff covers most
        // dev startup windows without leaving the user staring at a dead pane.
        const delays = [0, 500, 1500, 3000];
        await Promise.all(
            opened.map(async (cwd) => {
                let lastErr: unknown;
                for (const delay of delays) {
                    if (delay > 0) {
                        console.warn(`[taco] retrying start+sessionList for ${cwd} in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                    }
                    try {
                        await client.start(cwd, {
                            debugMode: settings.debugMode,
                            llmDumpToFile: settings.llmDumpToFile,
                        });
                        const list = await client.sessionList(cwd);
                        dispatchListResult(cwd, list, false);
                        firstSessionByCwd[cwd] = sortSessionsByUpdatedDesc(list.sessions ?? [])[0];
                        return;
                    } catch (err) {
                        lastErr = err;
                    }
                }
                console.error("[taco] loadWorkspaceSessions failed after retries", cwd, lastErr);
            }),
        );
        try {
            await loadGlobalConfig(client);
        } catch (e) {
            console.error("[taco] loadGlobalConfig failed", e);
        }
        const firstSession = firstSessionByCwd[activeTarget];
        if (firstSession) {
            await attachSessionInternal(activeTarget, firstSession.id);
        }
    }, [client, attachSessionInternal, dispatchListResult]);

    /** Called after sidecar restart — the sidecar process is replaced, so all attached session
     * IDs become invalid in the new process. Refetch every workspace's session list + attach the
     * first, syncing client state with the new sidecar. */
    const reloadAllWorkspaces = useCallback(async (): Promise<void> => {
        const openedCwds = Object.keys(workspacesRef.current);
        // Active cwd lives in desktop.json now (it survives the sidecar restart
        // that triggered this reload — localStorage would also have survived, but
        // we go through the new path to keep both sources in sync).
        const storedActive = await loadActiveCwd();
        const activeTarget = resolveActiveCwd(storedActive, openedCwds);
        const firstSessionByCwd: Record<string, SessionMeta | undefined> = {};
        await Promise.all(
            openedCwds.map(async (cwd) => {
                try {
                    const list = await client.sessionList(cwd);
                    dispatchListResult(cwd, list, false);
                    firstSessionByCwd[cwd] = sortSessionsByUpdatedDesc(list.sessions ?? [])[0];
                } catch (err) {
                    console.error("[taco] sessionList failed (restart)", cwd, err);
                }
            }),
        );
        const firstSession = firstSessionByCwd[activeTarget];
        if (firstSession) {
            await attachSessionInternal(activeTarget, firstSession.id);
        }
    }, [client, attachSessionInternal, dispatchListResult]);

    const openWorkspace = useCallback(
        async (rawCwd: string): Promise<boolean> => {
            const cwd = rawCwd.trim().replace(/\/+$/, "");
            if (!cwd) return false;
            if (!isValidWorkspaceCwd(cwd)) {
                const msg = `Invalid workspace path: ${JSON.stringify(cwd)} (contains glob or shell metacharacters; use a real directory path)`;
                console.error("[taco] openWorkspace rejected", cwd);
                setErrorBanner(msg);
                showToast(msg, "error");
                return false;
            }
            const alreadyOpen = Boolean(workspacesRef.current[cwd]);
            if (!alreadyOpen) {
                // Build next inside the updater and persistCwds(Object.keys(next)) immediately,
                // avoiding the stale-read of workspacesRef.current right after dispatchWs that
                // would drop the new cwd from localStorage.
                const nextCwds = [...Object.keys(workspacesRef.current), cwd];
                dispatchWs({
                    type: "INIT",
                    workspaces: {
                        ...workspacesRef.current,
                        [cwd]: createEmptyWorkspace(cwd),
                    },
                });
                persistCwds(nextCwds);
            }
            try {
                await loadWorkspaceSessions(cwd);
                await switchWorkspaceInternal(cwd);
                return true;
            } catch (err) {
                const msg = `Failed to open ${cwd}: ${(err as Error).message}`;
                console.error("[taco] openWorkspace failed", cwd, err);
                setErrorBanner(msg);
                showToast(msg, "error");
                return false;
            }
        },
        [loadWorkspaceSessions, showToast, switchWorkspaceInternal],
    );

    const browseAndOpen = useCallback(async () => {
        try {
            const picked = await openDialog({ directory: true, multiple: false });
            if (typeof picked === "string" && picked.length > 0) {
                await openWorkspace(picked);
            }
        } catch (err) {
            const msg = `Failed to open folder picker: ${(err as Error).message}`;
            console.error("[taco] browse failed", err);
            setErrorBanner(msg);
        }
    }, [openWorkspace]);

    const openImConversation = useCallback(
        async (cwd: string, sid: string): Promise<void> => {
            const addedNew = !workspacesRef.current[cwd];
            // Seed WorkspaceState FIRST — the ATTACH reducer is a no-op without
            // an existing entry, so the order is load-bearing.
            if (addedNew) {
                dispatchWs({
                    type: "INIT",
                    workspaces: {
                        ...workspacesRef.current,
                        [cwd]: createEmptyWorkspace(cwd),
                    },
                });
            }
            const prevActive = activeCwd;
            try {
                // Same path openWorkspace uses: awaits sidecarLogListenerReady,
                // passes debugMode/llmDumpToFile to client.start, and loads the
                // session list. A bare client.start() would leave ws.sessions
                // empty, so the Sidebar would render no sessions for an IM
                // conversation even though the chat itself attached fine.
                await loadWorkspaceSessions(cwd);
                // Activate inline rather than via switchWorkspaceInternal: that
                // helper auto-attaches sessions[0] when the workspace has no
                // active session, which would attach the wrong conversation (or
                // flash it) before our own attach lands. It also persists
                // activeCwd, and an im:// key must not reach the desktop.json
                // `workspaces.active` field — the next launch would resolve an
                // activeCwd with no WorkspaceState.
                setActiveCwd(cwd);
                dispatchWs({ type: "SET_ACTIVE", cwd });
                await attachSessionInternal(cwd, sid);
            } catch (err) {
                const msg = `Failed to open IM conversation: ${(err as Error).message}`;
                console.error("[taco] openImConversation failed", cwd, err);
                setErrorBanner(msg);
                showToast(msg, "error");
                // Roll back the half-opened workspace so a later retry starts
                // from a clean state instead of a dangling empty entry.
                if (addedNew) {
                    dispatchWs({ type: "REMOVE_WORKSPACE", cwd });
                }
                if (prevActive) {
                    setActiveCwd(prevActive);
                    dispatchWs({ type: "SET_ACTIVE", cwd: prevActive });
                }
            }
        },
        [loadWorkspaceSessions, attachSessionInternal, showToast, activeCwd],
    );

    const restoreSessionSnapshot = useCallback(
        async (
            cwd: string,
            sessionId: string,
            _sessionKind: "main" | "subagent",
        ): Promise<SnapshotRecovery> => {
            try {
                const snapshot = await client.sessionSnapshotGet(cwd, sessionId);
                const messages = historyToUiMessages(
                    snapshot.history.entries as Parameters<typeof historyToUiMessages>[0],
                );
                dispatchWs({
                    type: "RESTORE_SESSION_SNAPSHOT",
                    cwd,
                    sid: sessionId,
                    sessionKind: snapshot.sessionKind,
                    messages,
                    pendingAskUserIds:
                        snapshot.sessionKind === "main"
                            ? findPendingAskUserIds(messages)
                            : undefined,
                });
                if (snapshot.tasks) {
                    dispatchWs({
                        type: "TASKS_UPDATED",
                        cwd,
                        sid: sessionId,
                        active: snapshot.tasks.active,
                        history: snapshot.tasks.history,
                    });
                }
                if (snapshot.planState) {
                    dispatchWs({
                        type: "PLAN_STATE_UPDATED",
                        cwd,
                        sid: sessionId,
                        active: snapshot.planState.active,
                        currentSlug: snapshot.planState.currentSlug,
                    });
                }
                return { recovered: true, snapshotSeq: snapshot.snapshotSeq };
            } catch (err) {
                console.error("[taco] session snapshot recovery failed", cwd, sessionId, err);
                setErrorBanner(`Session recovery failed: ${(err as Error).message}`);
                return { recovered: false };
            }
        },
        [client],
    );

    const deleteSession = useCallback(
        async (cwd: string, sessionId: string): Promise<void> => {
            try {
                await client.sessionDelete(cwd, sessionId);
            } catch (err) {
                const msg = `Failed to delete session: ${(err as Error).message}`;
                console.error("[taco] deleteSession failed", cwd, sessionId, err);
                setErrorBanner(msg);
                return;
            }
            // workspacesRef is still stale after dispatchWs (sync happens on next render's useEffect),
            // so filter the remaining list on the old ref to avoid attaching to a just-deleted session.
            const existing = workspacesRef.current[cwd];
            const wasActive = existing?.activeSession === sessionId;
            const remaining = (existing?.sessions ?? []).filter((s) => s.id !== sessionId);
            dispatchWs({ type: "REMOVE_SESSION", cwd, sid: sessionId });
            if (wasActive && remaining[0]) {
                await attachSessionInternal(cwd, remaining[0].id);
            }
        },
        [client, attachSessionInternal],
    );

    /** Sidebar "load more" handler. Reads the cursor from reducer state and
     *  appends the next page. If the cursor is missing (e.g. a refresh reset
     *  it), the call is a no-op. */
    const loadMoreSessions = useCallback(
        async (cwd: string): Promise<void> => {
            const cursor = workspacesRef.current[cwd]?.listCursor;
            if (!cursor) return;
            try {
                const list = await client.sessionList(cwd, { cursor });
                dispatchListResult(cwd, list, true);
            } catch (err) {
                console.error("[taco] loadMoreSessions failed", cwd, err);
            }
        },
        [client, dispatchListResult],
    );

    const renameSession = useCallback(
        async (cwd: string, sessionId: string, name: string): Promise<void> => {
            try {
                await client.sessionRename(cwd, sessionId, name);
            } catch (err) {
                const msg = `Failed to rename session: ${(err as Error).message}`;
                console.error("[taco] renameSession failed", cwd, sessionId, err);
                setErrorBanner(msg);
                return;
            }
            // Reload only the current workspace's session list so the sidebar sees the new name.
            // Rename doesn't change the session set/order, so reloadAllWorkspaces (which iterates
            // every cwd and may accidentally attach) is unnecessary; the backend _nameCache was
            // precisely updated by rename, so this list call won't hit disk.
            await refreshSessionList(cwd);
        },
        [client, refreshSessionList],
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
        setPendingNewSessionModel(null); // staged model belongs to the abandoned session
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
        const state = getGlobalConfig();
        const uiLocale = state.client.uiLanguage;
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

                const initialLevel = defaultThinkingLevelForNewSession(state.global);
                // Two-step create: allocate the session id first (no prompt), then
                // send the prompt through the same blocking-but-push-friendly path
                // that sessionPrompt uses for existing sessions. This keeps the
                // streaming middle (tool calls, thinking deltas) visible because
                // activeSession is set before the LLM starts — the reducer's
                // APPLY_EVENT guard (activeSession !== action.sid) lets push
                // events through instead of dropping them.
                const created = await client.sessionCreate({
                    workspace: cwd,
                    thinkingLevel: initialLevel,
                });
                setSessionLevels((m) => ({ ...m, [created.sessionId]: initialLevel }));
                // Model staged while this session had no id yet (fresh-session
                // pre-send). Apply it as the new session's initial model (server
                // attaches with it) and record it in the per-session map so the
                // ModelMenu keeps showing it once the session exists. Cleared
                // here — it only applies to the first turn's attach; subsequent
                // switches go through session.setModel.
                const initialModel = pendingNewSessionModelRef.current;
                setPendingNewSessionModel(null); // ref syncs via effect
                if (initialModel) {
                    setSessionModels((m) => ({
                        ...m,
                        [created.sessionId]: initialModel,
                    }));
                }
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

    async function setSessionModel(next: ModelSelection): Promise<void> {
        const sid = activeWs?.activeSession;
        if (!sid) {
            // No session yet (fresh-session pre-send state): stage the choice so
            // sendPrompt's lazy-create branch applies it as the initial model.
            setPendingNewSessionModel(next);
            return;
        }
        try {
            await applyOptimistic(
                sessionModels,
                setSessionModels,
                sid,
                next,
                async () => {
                    await client.sessionSetModel(activeCwd, sid, next.provider, next.id);
                },
                "sessionSetModel",
            );
        } catch (err) {
            setErrorBanner(`Model change failed: ${(err as Error).message}`);
        }
    }

    async function setSessionLevel(next: ThinkingLevel): Promise<void> {
        const sid = activeWs?.activeSession;
        if (!sid) return;
        try {
            await applyOptimistic(
                sessionLevels,
                setSessionLevels,
                sid,
                next,
                async () => {
                    await client.sessionSetThinkingLevel(activeCwd, sid, next);
                },
                "sessionSetThinkingLevel",
            );
        } catch (err) {
            setErrorBanner(`Thinking level change failed: ${(err as Error).message}`);
        }
    }

    const activeLevel: ThinkingLevel | null = activeWs?.activeSession
        ? (sessionLevels[activeWs.activeSession] ??
          defaultThinkingLevelForNewSession(getGlobalConfig().global))
        : null;

    const activeModel: ModelSelection | null = activeWs?.activeSession
        ? (sessionModels[activeWs.activeSession] ?? null)
        : pendingNewSessionModel;

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
        sessionLevels,
        errorBanner,
        dispatch,
        dispatchWs,
        setErrorBanner,
        initFromStorage,
        reloadAllWorkspaces,
        loadMoreSessions,
        openWorkspace,
        browseAndOpen,
        openImConversation,
        switchWorkspace,
        attachSession,
        restoreSessionSnapshot,
        deleteSession,
        renameSession,
        beginPendingNewSession,
        sendPrompt,
        abortPrompt,
        setSessionModel,
        setSessionLevel,
        activeModel,
        activeLevel,
        loadSubagentHistory,
        setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => {
            askUserAnswersRef.current[toolCallId] = payload;
        },
    };
}
