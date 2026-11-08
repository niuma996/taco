/**
 * workspaceReducer — pure transition logic for workspace / session state.
 *
 * Extracted from useWorkspaces: no React dependency, independently testable.
 * All actions are pure functional updates (never mutate input state; the
 * in-place assignment in APPEND_ASSISTANT_FINAL targets a cloned array element,
 * not the original state).
 */

import type {
    AgentMessage,
    CommandPermissionRequest,
    PlanStateUpdatedParams,
    TaskItem,
    TaskListMeta,
    TasksUpdatedParams,
} from "@taco-ai/protocol";
import { applyEventToMessages } from "./applyEventToMessages";
import type { QueuedUiItem, SessionEventLike, UiMessage } from "./chatUtils";
import { AGENT_TOOL_NAMES, isBackgroundLaunchDetails, queuedItemsFromEvent } from "./chatUtils";
import {
    type BackgroundSubagentState,
    createSessionState,
    enforceSessionCache,
    getSessionState,
    hasSessionCache,
    mergeSessionHistory,
    normalizeSessionStates,
    projectSessionState,
    type SessionExecution,
    type SessionState,
    type SessionSync,
    type SubagentSpawnedEntry,
    updateSessionMessages,
} from "./sessionState";

import {
    attachAskUserAnswers,
    attachCommandPermission,
    backfillSubagentDetails,
    markRunningShellToolsFailed,
    mergeAssistantFinal,
} from "./workspaceMessagePatches";

export interface SessionMeta {
    id: string;
    createdAt: string;
    /** ISO mtime of the .jsonl (server-supplied). Falls back to createdAt when
     *  undefined (older sidecar / statSync failed). */
    updatedAt?: string;
    filePath?: string;
    /** User-defined title; falls back to first 8 chars of id when unset. */
    name?: string;
    /** Estimated message count (server-supplied), for sizing the loading skeleton. */
    messageCount?: number;
}

export type { BackgroundSubagentState, SubagentSpawnedEntry } from "./sessionState";

export interface WorkspaceState {
    cwd: string;
    active: boolean;
    sessions: SessionMeta[];
    activeSession?: string;
    draftId?: string;
    /** Optional only for callers constructing legacy workspace fixtures. */
    sessionStatesById?: Record<string, SessionState>;
    /** Compatibility reads project the active canonical session. */
    messages: UiMessage[];
    sessionInteractions?: Record<
        string,
        { messages: UiMessage[]; askUserPending: Record<string, true> }
    >;
    pendingBySessionId: Record<string, boolean>;
    queuedBySessionId: Record<string, QueuedUiItem[]>;
    subagentSpawned: Record<string, SubagentSpawnedEntry>;
    childMessagesBySubSessionId: Record<string, UiMessage[]>;
    childHistoryLoaded: Record<string, UiMessage[]>;
    askUserPending: Record<string, true>;
    pendingCommandPermissions: Record<string, CommandPermissionRequest>;
    taskSnapshotsBySessionId: Record<
        string,
        { active: TasksUpdatedParams["active"]; history: TaskListMeta[]; updatedAt: number }
    >;
    planStatesBySessionId: Record<string, { active: boolean; currentSlug: string | null }>;
    historyDetailsBySessionId: Record<
        string,
        Record<string, { tasks: TaskItem[]; loadedAt: number }>
    >;
    agentToolPending: Record<string, true>;
    backgroundSubagents: Record<string, BackgroundSubagentState>;
    listCursor?: { updatedAt: string; id: string };
    listTotal?: number;
    loadingSessionId?: string;
}

/**
 * Composite key: different toolCallIds under the same parentSessionId are different
 * agent calls and must be mapped separately. Reverse lookup via the
 * `parentSessionId + parentToolCallId` pair.
 */
export function subagentKey(parentSessionId: string, parentToolCallId: string): string {
    return `${parentSessionId}:${parentToolCallId}`;
}

/**
 * askUser / planExit share the same UI trigger: terminate with `questions`
 * + a two-state `waiting` flag. Both tools write `details.questions` and
 * drive the same pending/answered UX — treating them separately in the
 * reducer was the original duplication smell.
 */
function isAskUserStyleTool(toolName: string | undefined): boolean {
    return toolName === "askUser" || toolName === "planExit";
}

/**
 * Empty WorkspaceState factory. Single source of truth for the default shape
 * — every code path that allocates a fresh state (INIT placeholder, LOAD_SESSIONS
 * base, ATTACH resets, openWorkspace inserts) goes through this. Adding a new
 * state field becomes a one-line change here instead of a 4-place sync.
 */
export function createEmptyWorkspace(cwd: string, active = false): WorkspaceState {
    return {
        cwd,
        active,
        activeSession: undefined,
        sessions: [],
        messages: [],
        subagentSpawned: {},
        childMessagesBySubSessionId: {},
        childHistoryLoaded: {},
        askUserPending: {},
        pendingCommandPermissions: {},
        agentToolPending: {},
        backgroundSubagents: {},
        pendingBySessionId: {},
        queuedBySessionId: {},
        taskSnapshotsBySessionId: {},
        planStatesBySessionId: {},
        historyDetailsBySessionId: {},
        listCursor: undefined,
        listTotal: undefined,
    };
}

export type WorkspaceAction =
    | { type: "INIT"; workspaces: Record<string, WorkspaceState> }
    | { type: "UPSERT_WORKSPACE"; cwd: string }
    | { type: "SESSION_UNCERTAIN"; cwd: string; sid: string }
    | { type: "SET_SESSION_SYNC"; cwd: string; sid: string; sync: SessionSync }
    | { type: "SET_SESSION_EXECUTION"; cwd: string; sid: string; execution: SessionExecution }
    | { type: "REMOVE_WORKSPACE"; cwd: string }
    | { type: "SIDECAR_RESTARTED"; cwd: string }
    | { type: "SET_ACTIVE"; cwd: string }
    | {
          type: "LOAD_SESSIONS";
          cwd: string;
          sessions: SessionMeta[];
          /** Server's pagination cursor for the next page; undefined = no more. */
          nextCursor?: { updatedAt: string; id: string };
          /** Total session count (only when the server returned the full list). */
          total?: number;
          /** Append to existing sessions (paged load-more) instead of replacing. */
          append?: boolean;
      }
    | { type: "ADD_SESSION"; cwd: string; session: SessionMeta; makeActive?: boolean }
    /** The user opened `sid`; its attach + history load is in flight. */
    | { type: "ATTACH_START"; cwd: string; sid: string }
    /** Opening `sid` failed before any history arrived; fall back to what was shown. */
    | { type: "ATTACH_FAILED"; cwd: string; sid: string }
    | {
          /** Legacy callers without makeActive retain navigation race guards. */
          type: "ATTACH";
          cwd: string;
          /** Explicit false installs background history without changing selection. */
          makeActive?: boolean;
          sid: string;
          messages: UiMessage[];
          /** askUser toolCallIds still waiting in history — restore pending so selection can resume the turn */
          pendingAskUserIds?: string[];
          /** Background spawns still running, from the attach response. */
          inFlightAgentToolCallIds?: readonly string[];
          /** Child session ids that already produced a result file. */
          settledBackgroundSubSessionIds?: readonly string[];
      }
    | { type: "ATTACHED_PUSH"; cwd: string; sid: string }
    | {
          type: "COMMAND_PERMISSION_REQUESTED";
          cwd: string;
          sid: string;
          request: CommandPermissionRequest;
      }
    /** From the `command_permission.resolved` push; cards re-derive their buttons from the table. */
    | { type: "COMMAND_PERMISSION_RESOLVED"; cwd: string; requestId: string }
    | { type: "REMOVE_SESSION"; cwd: string; sid: string }
    | { type: "SET_PENDING"; cwd: string; sid: string; pending: boolean }
    | { type: "BUMP_SESSION_TIME"; cwd: string; sid: string; updatedAt: string }
    | { type: "SESSION_RENAMED"; cwd: string; sid: string; name: string }
    | { type: "APPEND_SYSTEM"; cwd: string; sid: string; msg: UiMessage }
    | {
          type: "APPEND_ASSISTANT_FINAL";
          cwd: string;
          sid: string;
          reply: AgentMessage;
          preserveExecution?: boolean;
      }
    | {
          /** The matching server message replaces this optimistic row by text. */
          type: "APPEND_USER";
          cwd: string;
          sid?: string;
          msg: UiMessage;
      }
    | {
          /** Local placeholder row shown while an enqueue RPC is in flight. */
          type: "APPEND_QUEUED";
          cwd: string;
          sid: string;
          item: QueuedUiItem;
      }
    | {
          /**
           * Drop one queued row by id: retires an optimistic row once its enqueue
           * RPC settles, or removes a server row optimistically on cancel.
           */
          type: "REMOVE_QUEUED";
          cwd: string;
          sid: string;
          id: string;
      }
    | {
          type: "APPLY_EVENT";
          cwd: string;
          sid: string;
          suppressedThinking: boolean;
          now: number;
          ev: SessionEventLike;
      }
    | {
          type: "SUBAGENT_SPAWNED";
          cwd: string;
          parentSessionId: string;
          parentToolCallId: string;
          subSessionId: string;
          agentType: string;
      }
    | {
          type: "SUBAGENT_SETTLED";
          cwd: string;
          parentSessionId?: string;
          parentToolCallId: string;
          outcome: Exclude<BackgroundSubagentState, "running">;
      }
    | {
          type: "CHILD_MESSAGE_EVENT";
          cwd: string;
          subSessionId: string;
          ev: SessionEventLike;
          now: number;
          suppressedThinking: boolean;
      }
    | {
          type: "LOAD_SUBAGENT_HISTORY";
          cwd: string;
          subSessionId: string;
          messages: UiMessage[];
      }
    | {
          /** Authoritative state rebuilt after the realtime replay window was lost. */
          type: "RESTORE_SESSION_SNAPSHOT";
          cwd: string;
          sid: string;
          sessionKind: "main" | "subagent";
          messages: UiMessage[];
          pendingAskUserIds?: string[];
          /** Replay after this snapshot must reach its watermark before sync is current. */
          sync?: "recovering";
      }
    | {
          type: "ASKUSER_ANSWERED";
          cwd: string;
          sid?: string;
          toolCallId: string;
          /** Selected answers: question text → option label (single) or label array (multi). */
          answers: Record<string, string | string[]>;
      }
    | {
          type: "TASKS_UPDATED";
          cwd: string;
          sid: string;
          active: TasksUpdatedParams["active"];
          history: TaskListMeta[];
      }
    | {
          type: "PLAN_STATE_UPDATED";
          cwd: string;
          sid: string;
          active: PlanStateUpdatedParams["active"];
          currentSlug: PlanStateUpdatedParams["currentSlug"];
      }
    | {
          /** UI expand of a history list writes its full task details (per-session + per-listId isolated). */
          type: "HISTORY_DETAIL_LOADED";
          cwd: string;
          sid: string;
          listId: string;
          tasks: TaskItem[];
      }
    | {
          /**
           * Clear the active session + messages without any backend call. The first real
           * send (sendPrompt's `!ws?.activeSession` branch) creates the session with
           * `initialPrompt` and pulls the id from the response. Until then, the workspace
           * sits in an empty state — sessions list is kept so the user can re-attach.
           */
          type: "BEGIN_PENDING_NEW_SESSION";
          cwd: string;
          draftId?: string;
      };

/** Sessions sorted by updatedAt desc, falling back to createdAt when updatedAt
 *  is missing (older sidecar / statSync failed). Backend order is unreliable,
 *  "most recently active on top" is a fixed UI contract. Equal timestamps keep
 *  insertion order (V8 stable sort). */
export function sortSessionsByUpdatedDesc(sessions: SessionMeta[]): SessionMeta[] {
    return [...sessions].sort((a, b) => {
        const aTime = new Date(a.updatedAt ?? a.createdAt).getTime();
        const bTime = new Date(b.updatedAt ?? b.createdAt).getTime();
        return bTime - aTime;
    });
}

/**
 * Drop one key from a record, returning the original reference when the key is
 * absent so callers keep their no-op identity checks. Replaces the
 * `const { [k]: _, ...rest }` + `void _` dance the omit sites used to repeat.
 */
function omitKey<V>(map: Record<string, V>, key: string): Record<string, V> {
    if (!(key in map)) return map;
    const next = { ...map };
    delete next[key];
    return next;
}

function omitRequestsForSession(
    map: Record<string, CommandPermissionRequest>,
    sid: string,
): Record<string, CommandPermissionRequest> {
    const entries = Object.entries(map);
    const kept = entries.filter(
        ([, r]) => r.sessionId !== sid && (r.displaySessionId ?? r.sessionId) !== sid,
    );
    return kept.length === entries.length ? map : Object.fromEntries(kept);
}

/**
 * Rebuild `backgroundSubagents` from a freshly loaded history.
 *
 * The live map is in-memory, so switching sessions or restarting loses it —
 * and without it every background spawn falls back to its tool call, which has
 * reported `ok` since launch. Three signals put each one back:
 *
 *  - `details.status === "launched"` (persisted) says it was a background spawn
 *  - the attach response's in-flight list says it is still running *now*
 *  - a result file for its child session says it settled at some point, which
 *    is the only evidence that survives the process that ran it
 *
 * Neither running nor settled means the child stopped without finishing — the
 * sidecar exited mid-run — so it is reported as an error rather than silently
 * reading as complete. The result file cannot say *which* outcome, so a settled
 * child reads as `completed`; its own session holds the detail.
 */
function rebuildBackgroundSubagents(
    messages: readonly UiMessage[],
    inFlightAgentToolCallIds: readonly string[] | undefined,
    settledBackgroundSubSessionIds: readonly string[] | undefined,
): Record<string, BackgroundSubagentState> {
    const inFlight = new Set(inFlightAgentToolCallIds ?? []);
    const settled = new Set(settledBackgroundSubSessionIds ?? []);
    const out: Record<string, BackgroundSubagentState> = {};
    for (const message of messages) {
        if (message.kind !== "assistant") continue;
        for (const tool of message.tools ?? []) {
            if (!AGENT_TOOL_NAMES.has(tool.name) || typeof tool.id !== "string") continue;
            if (!isBackgroundLaunchDetails(tool.details)) continue;
            const subSessionId = (tool.details as { subSessionId?: unknown }).subSessionId;
            if (inFlight.has(tool.id)) {
                out[tool.id] = "running";
            } else if (typeof subSessionId === "string" && settled.has(subSessionId)) {
                out[tool.id] = "completed";
            } else {
                out[tool.id] = "error";
            }
        }
    }
    return out;
}

/** Shallow equality for backgroundSubagents, so a no-change refresh keeps
 *  the no-op identity (updateWs hands the original state back). */
function sameBackgroundStates(
    a: Record<string, BackgroundSubagentState>,
    b: Record<string, BackgroundSubagentState>,
): boolean {
    const aKeys = Object.keys(a);
    return aKeys.length === Object.keys(b).length && aKeys.every((k) => a[k] === b[k]);
}

function updateWs(
    state: Record<string, WorkspaceState>,
    cwd: string,
    patch: (ws: WorkspaceState) => Partial<WorkspaceState> | undefined,
): Record<string, WorkspaceState> {
    const existing = state[cwd];
    if (!existing) return state;
    const normalized = normalizeSessionStates(existing);
    const next = patch(normalized);
    if (!next) return state;
    const ws = projectSessionState(enforceSessionCache({ ...normalized, ...next }));
    return { ...state, [cwd]: ws };
}

function patchSession(
    ws: WorkspaceState,
    sid: string,
    patch: Partial<SessionState>,
): Partial<WorkspaceState> {
    const previous = getSessionState(ws, sid) ?? createSessionState();
    const updated = patch.messages ? updateSessionMessages(previous, patch.messages) : previous;
    const lastAccess =
        Math.max(0, ...Object.values(ws.sessionStatesById ?? {}).map((s) => s.lastAccess)) + 1;
    return {
        sessionStatesById: { ...ws.sessionStatesById, [sid]: { ...updated, ...patch, lastAccess } },
    };
}

function applySessionEvent(
    ws: WorkspaceState,
    sid: string,
    action: Extract<WorkspaceAction, { type: "APPLY_EVENT" | "CHILD_MESSAGE_EVENT" }>,
): Partial<WorkspaceState> {
    const session = getSessionState(ws, sid) ?? createSessionState();
    const ev = action.ev;
    const messages = applyEventToMessages(session.messages, ev, {
        now: action.now,
        suppressedThinking: action.suppressedThinking,
    }).messages;
    let pendingBySessionId = ws.pendingBySessionId;
    let execution = session.execution;
    if (ev.type === "run_start" || ev.type === "run_end") {
        execution = ev.type === "run_start" ? "running" : "idle";
        pendingBySessionId = { ...pendingBySessionId, [sid]: execution === "running" };
    }
    let queuedBySessionId = ws.queuedBySessionId;
    if (ev.type === "queue_update") {
        const next = [
            ...(queuedBySessionId[sid] ?? []).filter((q) => q.optimistic),
            ...queuedItemsFromEvent(ev),
        ];
        queuedBySessionId = next.length
            ? { ...queuedBySessionId, [sid]: next }
            : omitKey(queuedBySessionId, sid);
    } else if (ev.type === "operation_abort") queuedBySessionId = omitKey(queuedBySessionId, sid);
    let askUserPending = session.askUserPending;
    let agentToolPending = session.agentToolPending;
    let backgroundSubagents = session.backgroundSubagents;
    if (ev.type === "tool_end") {
        const id = ev.toolCallId ?? "";
        if (!ev.isError && isAskUserStyleTool(ev.toolName)) {
            askUserPending =
                (ev.result?.details as { waiting?: boolean } | undefined)?.waiting === true
                    ? { ...askUserPending, [id]: true }
                    : omitKey(askUserPending, id);
        }
        if (ev.toolName === "agent" || ev.toolName === "skill")
            agentToolPending = omitKey(agentToolPending, id);
        if (ev.toolName === "agent" && isBackgroundLaunchDetails(ev.result?.details))
            backgroundSubagents = { ...backgroundSubagents, [id]: "running" };
    }
    return {
        ...patchSession(ws, sid, {
            messages,
            execution,
            askUserPending,
            agentToolPending,
            backgroundSubagents,
            ...(action.type === "CHILD_MESSAGE_EVENT" ? { kind: "subagent" } : {}),
        }),
        pendingBySessionId,
        queuedBySessionId,
    };
}

export function workspacesReducer(
    state: Record<string, WorkspaceState>,
    action: WorkspaceAction,
): Record<string, WorkspaceState> {
    switch (action.type) {
        case "INIT":
            return Object.fromEntries(
                Object.entries(action.workspaces).map(([cwd, ws]) => [
                    cwd,
                    projectSessionState(enforceSessionCache(normalizeSessionStates(ws))),
                ]),
            );
        case "UPSERT_WORKSPACE":
            return state[action.cwd]
                ? state
                : { ...state, [action.cwd]: createEmptyWorkspace(action.cwd) };
        case "REMOVE_WORKSPACE":
            return omitKey(state, action.cwd);
        case "SET_ACTIVE": {
            const next = { ...state };
            for (const [cwd, ws] of Object.entries(state)) {
                if (ws.active !== (cwd === action.cwd))
                    next[cwd] = projectSessionState({
                        ...normalizeSessionStates(ws),
                        active: cwd === action.cwd,
                    });
            }
            return next;
        }
        case "SIDECAR_RESTARTED":
            return updateWs(state, action.cwd, (ws) => ({
                sessionStatesById: Object.fromEntries(
                    Object.entries(ws.sessionStatesById ?? {}).map(([sid, session]) => [
                        sid,
                        {
                            ...updateSessionMessages(
                                session,
                                markRunningShellToolsFailed(session.messages),
                            ),
                            execution: "unknown" as const,
                            sync: "recovering" as const,
                            historyRequestRevision: session.revision,
                            askUserPending: {},
                            agentToolPending: {},
                            backgroundSubagents: Object.fromEntries(
                                Object.entries(session.backgroundSubagents).filter(
                                    ([, value]) => value !== "running",
                                ),
                            ),
                        },
                    ]),
                ),
                pendingBySessionId: {},
                queuedBySessionId: {},
                pendingCommandPermissions: {},
            }));
        case "SESSION_UNCERTAIN":
            return updateWs(state, action.cwd, (ws) => ({
                ...patchSession(ws, action.sid, { execution: "unknown", sync: "incomplete" }),
                pendingBySessionId: omitKey(ws.pendingBySessionId, action.sid),
            }));
        case "SET_SESSION_SYNC":
            return updateWs(state, action.cwd, (ws) =>
                patchSession(ws, action.sid, {
                    sync: action.sync,
                    ...(action.sync === "recovering"
                        ? { historyRequestRevision: getSessionState(ws, action.sid)?.revision ?? 0 }
                        : {}),
                }),
            );
        case "SET_SESSION_EXECUTION":
            return updateWs(state, action.cwd, (ws) => ({
                ...patchSession(ws, action.sid, { execution: action.execution }),
                pendingBySessionId:
                    action.execution === "unknown"
                        ? omitKey(ws.pendingBySessionId, action.sid)
                        : {
                              ...ws.pendingBySessionId,
                              [action.sid]: action.execution === "running",
                          },
            }));
        case "LOAD_SESSIONS": {
            const ws = state[action.cwd] ?? createEmptyWorkspace(action.cwd);
            return updateWs({ ...state, [action.cwd]: ws }, action.cwd, (existing) => ({
                sessions: sortSessionsByUpdatedDesc(
                    action.append ? [...existing.sessions, ...action.sessions] : action.sessions,
                ),
                listCursor: action.nextCursor,
                listTotal: action.total,
            }));
        }
        case "ADD_SESSION":
            return updateWs(state, action.cwd, (ws) => ({
                ...patchSession(
                    ws,
                    action.session.id,
                    getSessionState(ws, action.session.id)
                        ? {}
                        : { sync: "current", execution: "unknown" },
                ),
                sessions: sortSessionsByUpdatedDesc([...ws.sessions, action.session]),
                ...(action.makeActive === false
                    ? {}
                    : { activeSession: action.session.id, draftId: undefined }),
            }));
        case "ATTACH_START":
            return updateWs(state, action.cwd, (ws) => {
                if (ws.activeSession === action.sid)
                    return ws.loadingSessionId === undefined
                        ? undefined
                        : { loadingSessionId: undefined };
                const session = getSessionState(ws, action.sid) ?? createSessionState();
                if (hasSessionCache(ws, action.sid))
                    return {
                        ...patchSession(ws, action.sid, {}),
                        activeSession: action.sid,
                        draftId: undefined,
                        loadingSessionId: undefined,
                    };
                if (ws.loadingSessionId === action.sid) return undefined;
                return {
                    ...patchSession(ws, action.sid, {
                        sync: "recovering",
                        historyRequestRevision: session.revision,
                    }),
                    loadingSessionId: action.sid,
                };
            });
        case "ATTACH_FAILED":
            return updateWs(state, action.cwd, (ws) =>
                ws.loadingSessionId === action.sid
                    ? {
                          ...patchSession(ws, action.sid, { sync: "incomplete" }),
                          loadingSessionId: undefined,
                      }
                    : undefined,
            );
        case "ATTACH":
            return updateWs(state, action.cwd, (ws) => {
                if (
                    action.makeActive === undefined &&
                    ws.activeSession !== action.sid &&
                    ws.loadingSessionId !== action.sid
                )
                    return undefined;
                const session = getSessionState(ws, action.sid) ?? createSessionState();
                const sameCurrent =
                    ws.activeSession === action.sid && hasSessionCache(ws, action.sid);
                // An existing live view without a history request remains authoritative.
                const preserveLive =
                    ws.activeSession === action.sid &&
                    session.historyRequestRevision === undefined &&
                    session.revision === 0;
                if (
                    (sameCurrent || preserveLive) &&
                    action.inFlightAgentToolCallIds === undefined &&
                    action.settledBackgroundSubSessionIds === undefined
                )
                    return undefined;
                const restored =
                    sameCurrent || preserveLive
                        ? session
                        : mergeSessionHistory(session, action.messages);
                const backgroundSubagents = {
                    ...session.backgroundSubagents,
                    ...rebuildBackgroundSubagents(
                        action.messages,
                        action.inFlightAgentToolCallIds,
                        action.settledBackgroundSubSessionIds,
                    ),
                };
                for (const [id, value] of Object.entries(session.backgroundSubagents))
                    if (value !== "running") backgroundSubagents[id] = value;
                if (
                    (sameCurrent || preserveLive) &&
                    sameBackgroundStates(backgroundSubagents, session.backgroundSubagents)
                )
                    return undefined;
                const askUserPending = { ...restored.askUserPending };
                for (const id of action.pendingAskUserIds ?? []) {
                    const tool = restored.messages
                        .flatMap((m) => (m.kind === "assistant" ? (m.tools ?? []) : []))
                        .find((t) => t.id === id);
                    const details = tool?.details as
                        | { answers?: unknown; waiting?: boolean }
                        | undefined;
                    if (!details?.answers && details?.waiting !== false) askUserPending[id] = true;
                }
                return {
                    ...patchSession(ws, action.sid, {
                        ...restored,
                        askUserPending,
                        backgroundSubagents,
                    }),
                    ...(action.makeActive === false
                        ? {}
                        : { activeSession: action.sid, draftId: undefined }),
                    ...(ws.loadingSessionId === action.sid ? { loadingSessionId: undefined } : {}),
                };
            });
        case "ATTACHED_PUSH":
            return state;
        case "COMMAND_PERMISSION_REQUESTED":
            return updateWs(
                state[action.cwd]
                    ? state
                    : { ...state, [action.cwd]: createEmptyWorkspace(action.cwd) },
                action.cwd,
                (ws) => ({
                    ...patchSession(ws, action.sid, {
                        messages: attachCommandPermission(
                            getSessionState(ws, action.sid)?.messages ?? [],
                            action.request,
                        ),
                    }),
                    pendingCommandPermissions: {
                        ...ws.pendingCommandPermissions,
                        [action.request.requestId]: action.request,
                    },
                }),
            );
        case "COMMAND_PERMISSION_RESOLVED":
            return updateWs(state, action.cwd, (ws) => ({
                pendingCommandPermissions: omitKey(ws.pendingCommandPermissions, action.requestId),
            }));
        case "REMOVE_SESSION":
            return updateWs(state, action.cwd, (ws) => ({
                sessions: ws.sessions.filter((s) => s.id !== action.sid),
                sessionStatesById: omitKey(ws.sessionStatesById ?? {}, action.sid),
                ...(ws.activeSession === action.sid ? { activeSession: undefined } : {}),
                ...(ws.loadingSessionId === action.sid ? { loadingSessionId: undefined } : {}),
                ...(ws.listCursor?.id === action.sid ? { listCursor: undefined } : {}),
                ...(ws.listTotal === undefined ? {} : { listTotal: Math.max(0, ws.listTotal - 1) }),
                pendingBySessionId: omitKey(ws.pendingBySessionId, action.sid),
                queuedBySessionId: omitKey(ws.queuedBySessionId, action.sid),
                pendingCommandPermissions: omitRequestsForSession(
                    ws.pendingCommandPermissions,
                    action.sid,
                ),
                taskSnapshotsBySessionId: omitKey(ws.taskSnapshotsBySessionId, action.sid),
                planStatesBySessionId: omitKey(ws.planStatesBySessionId, action.sid),
                historyDetailsBySessionId: omitKey(ws.historyDetailsBySessionId, action.sid),
            }));
        case "SET_PENDING":
            return updateWs(state, action.cwd, (ws) => ({
                ...patchSession(ws, action.sid, { execution: action.pending ? "running" : "idle" }),
                pendingBySessionId: { ...ws.pendingBySessionId, [action.sid]: action.pending },
            }));
        case "BUMP_SESSION_TIME":
        case "SESSION_RENAMED":
            return updateWs(state, action.cwd, (ws) =>
                ws.sessions.some((s) => s.id === action.sid)
                    ? {
                          sessions:
                              action.type === "BUMP_SESSION_TIME"
                                  ? sortSessionsByUpdatedDesc(
                                        ws.sessions.map((s) =>
                                            s.id === action.sid
                                                ? { ...s, updatedAt: action.updatedAt }
                                                : s,
                                        ),
                                    )
                                  : ws.sessions.map((s) =>
                                        s.id === action.sid ? { ...s, name: action.name } : s,
                                    ),
                      }
                    : undefined,
            );
        case "APPEND_SYSTEM":
        case "APPEND_ASSISTANT_FINAL":
            return updateWs(state, action.cwd, (ws) => ({
                ...patchSession(ws, action.sid, {
                    messages:
                        action.type === "APPEND_SYSTEM"
                            ? [...(getSessionState(ws, action.sid)?.messages ?? []), action.msg]
                            : mergeAssistantFinal(
                                  getSessionState(ws, action.sid)?.messages ?? [],
                                  action.reply,
                              ),
                    ...(action.type === "APPEND_ASSISTANT_FINAL" && !action.preserveExecution
                        ? { execution: "idle" as const }
                        : {}),
                }),
                ...(action.type === "APPEND_ASSISTANT_FINAL" && !action.preserveExecution
                    ? { pendingBySessionId: { ...ws.pendingBySessionId, [action.sid]: false } }
                    : {}),
            }));
        case "APPEND_USER":
            return updateWs(state, action.cwd, (ws) => {
                const sid = action.sid ?? ws.activeSession;
                return sid
                    ? patchSession(ws, sid, {
                          messages: [...(getSessionState(ws, sid)?.messages ?? []), action.msg],
                      })
                    : undefined;
            });
        case "APPEND_QUEUED":
            return updateWs(state, action.cwd, (ws) => ({
                queuedBySessionId: {
                    ...ws.queuedBySessionId,
                    [action.sid]: [...(ws.queuedBySessionId[action.sid] ?? []), action.item],
                },
            }));
        case "REMOVE_QUEUED":
            return updateWs(state, action.cwd, (ws) => {
                const previous = ws.queuedBySessionId[action.sid];
                if (!previous?.some((q) => q.id === action.id)) return undefined;
                const remaining = previous.filter((q) => q.id !== action.id);
                return {
                    queuedBySessionId: remaining.length
                        ? { ...ws.queuedBySessionId, [action.sid]: remaining }
                        : omitKey(ws.queuedBySessionId, action.sid),
                };
            });
        case "APPLY_EVENT":
            return updateWs(state, action.cwd, (ws) => applySessionEvent(ws, action.sid, action));
        case "SUBAGENT_SPAWNED":
            return updateWs(state, action.cwd, (ws) => {
                const parent = getSessionState(ws, action.parentSessionId) ?? createSessionState();
                const child = getSessionState(ws, action.subSessionId) ?? createSessionState();
                const parentPatch = patchSession(ws, action.parentSessionId, {
                    messages: backfillSubagentDetails(
                        parent.messages,
                        action.parentToolCallId,
                        action.subSessionId,
                        action.agentType,
                    ),
                    agentToolPending:
                        parent.backgroundSubagents[action.parentToolCallId] !== undefined
                            ? parent.agentToolPending
                            : { ...parent.agentToolPending, [action.parentToolCallId]: true },
                });
                return {
                    ...patchSession({ ...ws, ...parentPatch }, action.subSessionId, {
                        ...child,
                        kind: "subagent",
                    }),
                    subagentSpawned: {
                        ...ws.subagentSpawned,
                        [subagentKey(action.parentSessionId, action.parentToolCallId)]: {
                            subSessionId: action.subSessionId,
                            agentType: action.agentType,
                            parentToolCallId: action.parentToolCallId,
                        },
                    },
                };
            });
        case "SUBAGENT_SETTLED":
            return updateWs(state, action.cwd, (ws) => {
                const matches = action.parentSessionId
                    ? [action.parentSessionId]
                    : Object.keys(ws.sessionStatesById ?? {}).filter((sid) => {
                          const s = ws.sessionStatesById?.[sid];
                          return (
                              s?.agentToolPending[action.parentToolCallId] ||
                              s?.backgroundSubagents[action.parentToolCallId] !== undefined
                          );
                      });
                const sid =
                    matches.length === 1
                        ? matches[0]
                        : matches.length === 0
                          ? ws.activeSession
                          : undefined;
                if (!sid) return undefined;
                const session = getSessionState(ws, sid) ?? createSessionState();
                return patchSession(ws, sid, {
                    agentToolPending: omitKey(session.agentToolPending, action.parentToolCallId),
                    backgroundSubagents: {
                        ...session.backgroundSubagents,
                        [action.parentToolCallId]: action.outcome,
                    },
                });
            });
        case "CHILD_MESSAGE_EVENT":
            return updateWs(state, action.cwd, (ws) =>
                applySessionEvent(ws, action.subSessionId, action),
            );
        case "LOAD_SUBAGENT_HISTORY":
            return updateWs(state, action.cwd, (ws) =>
                patchSession(ws, action.subSessionId, {
                    ...mergeSessionHistory(
                        getSessionState(ws, action.subSessionId) ?? createSessionState(),
                        action.messages,
                    ),
                    kind: "subagent",
                }),
            );
        case "RESTORE_SESSION_SNAPSHOT":
            return updateWs(state, action.cwd, (ws) => {
                const restored = mergeSessionHistory(
                    getSessionState(ws, action.sid) ?? createSessionState(),
                    action.messages,
                );
                for (const id of action.pendingAskUserIds ?? []) {
                    const tool = restored.messages
                        .flatMap((m) => (m.kind === "assistant" ? (m.tools ?? []) : []))
                        .find((t) => t.id === id);
                    const details = tool?.details as
                        | { answers?: unknown; waiting?: boolean }
                        | undefined;
                    if (!details?.answers && details?.waiting !== false)
                        restored.askUserPending[id] = true;
                }
                return patchSession(ws, action.sid, {
                    ...restored,
                    kind: action.sessionKind,
                    sync: action.sync ?? restored.sync,
                });
            });
        case "ASKUSER_ANSWERED":
            return updateWs(state, action.cwd, (ws) => {
                const sid = action.sid ?? ws.activeSession;
                const session = sid ? getSessionState(ws, sid) : undefined;
                return session && sid
                    ? patchSession(ws, sid, {
                          messages: attachAskUserAnswers(
                              session.messages,
                              action.toolCallId,
                              action.answers,
                          ),
                          askUserPending: omitKey(session.askUserPending, action.toolCallId),
                      })
                    : undefined;
            });
        case "TASKS_UPDATED":
            return updateWs(state, action.cwd, (ws) => ({
                taskSnapshotsBySessionId: {
                    ...ws.taskSnapshotsBySessionId,
                    [action.sid]: {
                        active: action.active,
                        history: action.history,
                        updatedAt: Date.now(),
                    },
                },
            }));
        case "PLAN_STATE_UPDATED":
            return updateWs(state, action.cwd, (ws) => ({
                planStatesBySessionId: {
                    ...ws.planStatesBySessionId,
                    [action.sid]: { active: action.active, currentSlug: action.currentSlug },
                },
            }));
        case "HISTORY_DETAIL_LOADED":
            return updateWs(state, action.cwd, (ws) => ({
                historyDetailsBySessionId: {
                    ...ws.historyDetailsBySessionId,
                    [action.sid]: {
                        ...ws.historyDetailsBySessionId[action.sid],
                        [action.listId]: { tasks: action.tasks, loadedAt: Date.now() },
                    },
                },
            }));
        case "BEGIN_PENDING_NEW_SESSION":
            return updateWs(state, action.cwd, () => ({
                activeSession: undefined,
                loadingSessionId: undefined,
                draftId: action.draftId,
            }));
    }
}
