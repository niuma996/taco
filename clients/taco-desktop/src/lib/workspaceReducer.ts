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
import type { SessionEventLike, UiMessage } from "./chatUtils";
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
}

export interface SubagentSpawnedEntry {
    subSessionId: string;
    agentType: string;
    /** Key for agentToolPending; not consumed by UI, only used for reverse lookup on end. */
    parentToolCallId: string;
}

export interface WorkspaceState {
    cwd: string;
    active: boolean;
    sessions: SessionMeta[];
    activeSession?: string;
    messages: UiMessage[];
    /**
     * sessionId → whether that session has an in-flight turn.
     * Per-session slot: switching sessions doesn't cross-contaminate; switching
     * back to a running session restores the "stop" button.
     */
    pendingBySessionId: Record<string, boolean>;
    /**
     * parentSession + parentToolCallId composite key → child sessionId + agentType.
     * Written by SUBAGENT_SPAWNED; cleared on ATTACH/INIT/REMOVE_SESSION (no cross-session residue).
     */
    subagentSpawned: Record<string, SubagentSpawnedEntry>;
    /** child sessionId → live-accumulated UiMessage stream (written by CHILD_MESSAGE_EVENT) */
    childMessagesBySubSessionId: Record<string, UiMessage[]>;
    /** child sessionId → lazily-loaded history UiMessages (triggered on expand) */
    childHistoryLoaded: Record<string, UiMessage[]>;
    /**
     * toolCallId → true means an askUser tool is waiting for user selection.
     * Source of truth for questions is tool.details.questions (written by
     * applyEventToMessages). Set when tool_execution_end has details.waiting === true;
     * cleared by ASKUSER_ANSWERED. Also applies to planExit: reducer treats it as an
     * askUser-style two-state tool (first waiting=true, second answered).
     */
    askUserPending: Record<string, true>;
    /**
     * sessionId → task snapshot.
     * Driven by sidecar's tasks.updated push (normalized via useSidecarStream dispatch).
     * Per-session slot: switching sessions doesn't cross-contaminate.
     */
    taskSnapshotsBySessionId: Record<
        string,
        { active: TasksUpdatedParams["active"]; history: TaskListMeta[]; updatedAt: number }
    >;
    /** sessionId → plan truth state. */
    planStatesBySessionId: Record<string, { active: boolean; currentSlug: string | null }>;
    /**
     * sessionId → (historyListId → full task details + load timestamp).
     * History only sends meta by default; UI fetches full details via RPC on expand.
     */
    historyDetailsBySessionId: Record<
        string,
        Record<string, { tasks: TaskItem[]; loadedAt: number }>
    >;
    /**
     * TaskPanel should be force-expanded (dispatched when the first task snapshot
     * for a sid lands). Cleared by CONSUMED after TaskPanel reads it, so an
     * old-snapshot re-push doesn't keep popping the panel open. Not persisted.
     */
    forceExpandTaskPanel: boolean;
    /**
     * parentToolCallId → true tracks agent tool calls awaiting subagent results.
     * Written by SUBAGENT_SPAWNED; cleared by the corresponding tool_execution_end (agent).
     * Used by UI to block sending: pending is false but a subagent running should still block.
     */
    agentToolPending: Record<string, true>;
    /**
     * Pagination cursor for "load more". Undefined = first page (or a refresh
     * reset the list to the first page). Sidebar uses this to enable/disable
     * the load-more button. */
    listCursor?: { updatedAt: string; id: string };
    /** Total session count in the workspace; only set when the server returned
     *  the full list (params.full === true). Lets the sidebar show "N sessions"
     *  even after a paged load hides the rest. */
    listTotal?: number;
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
        agentToolPending: {},
        pendingBySessionId: {},
        taskSnapshotsBySessionId: {},
        planStatesBySessionId: {},
        historyDetailsBySessionId: {},
        forceExpandTaskPanel: false,
        listCursor: undefined,
        listTotal: undefined,
    };
}

export type WorkspaceAction =
    | { type: "INIT"; workspaces: Record<string, WorkspaceState> }
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
    | {
          type: "ATTACH";
          cwd: string;
          sid: string;
          messages: UiMessage[];
          /** askUser toolCallIds still waiting in history — restore pending so selection can resume the turn */
          pendingAskUserIds?: string[];
      }
    | { type: "ATTACHED_PUSH"; cwd: string; sid: string }
    | {
          type: "COMMAND_PERMISSION_REQUESTED";
          cwd: string;
          sid: string;
          request: CommandPermissionRequest;
      }
    | { type: "REMOVE_SESSION"; cwd: string; sid: string }
    | { type: "SET_PENDING"; cwd: string; sid: string; pending: boolean }
    | { type: "BUMP_SESSION_TIME"; cwd: string; sid: string; updatedAt: string }
    | { type: "APPEND_SYSTEM"; cwd: string; sid: string; msg: UiMessage }
    | { type: "APPEND_ASSISTANT_FINAL"; cwd: string; sid: string; reply: AgentMessage }
    | {
          /**
           * Optimistic user message appended before the server confirms. Used by
           * sendPrompt's lazy-create branch so the user sees their input immediately
           * while sessionCreate is in flight. When the server's `message_end(user)`
           * push arrives, applyEventToMessages replaces this entry with the
           * server-timestamped one (matched by text).
           */
          type: "APPEND_USER";
          cwd: string;
          msg: UiMessage;
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
      }
    | {
          type: "ASKUSER_ANSWERED";
          cwd: string;
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
          /** Dispatched by useSidecarStream on first task snapshot for a sid; TaskPanel re-expands on it. */
          type: "TASK_PANEL_FORCE_EXPAND";
          cwd: string;
      }
    | {
          /** TaskPanel clears the force-expand flag after consuming it once to avoid retriggering. */
          type: "TASK_PANEL_FORCE_EXPAND_CONSUMED";
          cwd: string;
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

/**
 * Guard + merge for the "patch exactly one workspace" shape nearly every action
 * shares. `patch` returning undefined means "no-op": the original `state`
 * reference is handed back, which is load-bearing — useReducer only skips the
 * re-render on referential equality.
 */
function updateWs(
    state: Record<string, WorkspaceState>,
    cwd: string,
    patch: (ws: WorkspaceState) => Partial<WorkspaceState> | undefined,
): Record<string, WorkspaceState> {
    const existing = state[cwd];
    if (!existing) return state;
    const next = patch(existing);
    if (!next) return state;
    return { ...state, [cwd]: { ...existing, ...next } };
}

export function workspacesReducer(
    state: Record<string, WorkspaceState>,
    action: WorkspaceAction,
): Record<string, WorkspaceState> {
    switch (action.type) {
        case "INIT":
            return action.workspaces;
        case "REMOVE_WORKSPACE": {
            // Drop the entry; no cross-state cleanup needed.
            const next: Record<string, WorkspaceState> = {};
            for (const k of Object.keys(state)) {
                if (k !== action.cwd) next[k] = state[k];
            }
            return next;
        }
        case "SIDECAR_RESTARTED":
            return updateWs(state, action.cwd, (existing) => {
                const childMessagesBySubSessionId: typeof existing.childMessagesBySubSessionId = {};
                for (const [subSid, childMessages] of Object.entries(
                    existing.childMessagesBySubSessionId ?? {},
                )) {
                    childMessagesBySubSessionId[subSid] =
                        markRunningShellToolsFailed(childMessages);
                }
                return {
                    messages: markRunningShellToolsFailed(existing.messages),
                    childMessagesBySubSessionId,
                };
            });
        case "SET_ACTIVE": {
            const next: Record<string, WorkspaceState> = {};
            for (const k of Object.keys(state)) {
                const ws = state[k];
                if (ws) next[k] = { ...ws, active: k === action.cwd };
            }
            return next;
        }
        case "LOAD_SESSIONS": {
            const existing = state[action.cwd];
            const base: WorkspaceState = existing ?? createEmptyWorkspace(action.cwd);
            // append mode (load more): append new page to existing list, then re-sort;
            // replace mode (refresh/reset): overwrite. Both update cursor + total.
            const merged = action.append
                ? sortSessionsByUpdatedDesc([...(existing?.sessions ?? []), ...action.sessions])
                : sortSessionsByUpdatedDesc(action.sessions);
            return {
                ...state,
                [action.cwd]: {
                    ...base,
                    sessions: merged,
                    listCursor: action.nextCursor,
                    listTotal: action.total,
                },
            };
        }
        case "ADD_SESSION":
            return updateWs(state, action.cwd, (existing) => ({
                sessions: sortSessionsByUpdatedDesc([...(existing.sessions ?? []), action.session]),
                activeSession:
                    action.makeActive === false ? existing.activeSession : action.session.id,
            }));
        case "ATTACH":
            return updateWs(state, action.cwd, (existing) => {
                // Same-session re-attach: keep the in-flight subagent live stream intact.
                // Only clear on switch to a different session (parent-child relation only
                // applies to the current parent session).
                if (existing.activeSession === action.sid) return undefined;
                // Restore pending for askUser toolCallIds still waiting in history so card
                // selection can resume the turn. The injection trigger is the pending
                // "true → false" transition; without restore, historical askUser clicks are dead.
                const restoredPending: Record<string, true> = {};
                for (const id of action.pendingAskUserIds ?? []) restoredPending[id] = true;
                return {
                    activeSession: action.sid,
                    messages: action.messages,
                    subagentSpawned: {},
                    childMessagesBySubSessionId: {},
                    childHistoryLoaded: {},
                    askUserPending: restoredPending,
                    agentToolPending: {},
                };
            });
        case "ATTACHED_PUSH":
            // activeSession is set uniformly by the ATTACH action (with history). This
            // push is just sidecar's ack for session.attach; overwriting activeSession
            // here would short-circuit the subsequent ATTACH (same-session) and drop
            // history — causing blank first-open or stale messages on new sessions.
            return state;
        case "COMMAND_PERMISSION_REQUESTED":
            return updateWs(state, action.cwd, (existing) => {
                if (existing.activeSession !== action.sid) return undefined;
                const messages = attachCommandPermission(existing.messages, action.request);
                return messages === existing.messages ? undefined : { messages };
            });
        case "REMOVE_SESSION":
            return updateWs(state, action.cwd, (existing) => {
                const remaining = existing.sessions.filter((s) => s.id !== action.sid);
                const wasActive = existing.activeSession === action.sid;
                // Cursor might have pointed at the removed session — clear it so the
                // sidebar doesn't try to load-more from a stale position. The next
                // refreshSessionList call refills cursor + total from the server.
                const clearedCursor =
                    existing.listCursor?.id === action.sid ? undefined : existing.listCursor;
                // Drop the removed sid's pending slot if present. A session that is
                // being removed (user deleted it, attach threw "session not found",
                // or any future caller) cannot still have a live turn — any `true`
                // here is a stale "running" indicator the sidebar would otherwise
                // keep rendering. Per-sid delete (not whole-map reset) so other
                // sessions' pending state survives when the user is multi-streaming.
                return {
                    sessions: remaining,
                    listCursor: clearedCursor,
                    ...(existing.listTotal !== undefined
                        ? { listTotal: Math.max(0, existing.listTotal - 1) }
                        : {}),
                    ...(wasActive ? { activeSession: undefined, messages: [] } : {}),
                    pendingBySessionId: omitKey(existing.pendingBySessionId, action.sid),
                };
            });
        case "SET_PENDING":
            return updateWs(state, action.cwd, (existing) => ({
                pendingBySessionId: {
                    ...existing.pendingBySessionId,
                    [action.sid]: action.pending,
                },
            }));
        case "BUMP_SESSION_TIME":
            return updateWs(state, action.cwd, (existing) => {
                const target = existing.sessions.find((s) => s.id === action.sid);
                if (!target) return undefined;
                const updated = { ...target, updatedAt: action.updatedAt };
                return {
                    sessions: sortSessionsByUpdatedDesc(
                        existing.sessions.map((s) => (s.id === action.sid ? updated : s)),
                    ),
                };
            });
        case "APPEND_SYSTEM":
            return updateWs(state, action.cwd, (existing) =>
                existing.activeSession !== action.sid
                    ? undefined
                    : {
                          messages: [...existing.messages, action.msg],
                          pendingBySessionId: {
                              ...existing.pendingBySessionId,
                              [action.sid]: false,
                          },
                      },
            );
        case "APPEND_ASSISTANT_FINAL":
            return updateWs(state, action.cwd, (existing) =>
                existing.activeSession !== action.sid
                    ? undefined
                    : {
                          messages: mergeAssistantFinal(existing.messages, action.reply),
                          pendingBySessionId: {
                              ...existing.pendingBySessionId,
                              [action.sid]: false,
                          },
                      },
            );
        case "APPEND_USER":
            // Optimistic user message: id is "optimistic-user-${ts}" so the
            // server push handler (applyEventToMessages.handleMessageEnd) can
            // recognise it later and replace it with the server-timestamped
            // entry instead of duplicating. See APPEND_USER's JSDoc.
            return updateWs(state, action.cwd, (existing) => ({
                messages: [...existing.messages, action.msg],
            }));
        case "APPLY_EVENT":
            return updateWs(state, action.cwd, (existing) => {
                // The shared messages array renders activeSession; background-session stream
                // events must be dropped, otherwise they bleed into the currently displayed
                // session (rebuilt from sessionEventLog / snapshot on switch-back).
                if (existing.activeSession !== action.sid) return undefined;
                const result = applyEventToMessages(existing.messages, action.ev, {
                    suppressedThinking: action.suppressedThinking,
                    now: action.now,
                });
                // toolName / isError / toolCallId live on the tool_execution_end branch of
                // the SessionEventLike union; access them only after the type guard so TS
                // narrows correctly.
                const endedToolCallId =
                    action.ev.type === "tool_execution_end" ? (action.ev.toolCallId ?? "") : null;
                let askUserPending = existing.askUserPending;
                // askUser / planExit share the same trigger: terminate + questions + a
                // two-state waiting flag. Both tool_execution_end frames write the same
                // tool card, so the second one carries no questions — clearing pending
                // relies on applyEventToMessages having already merged them.
                if (
                    action.ev.type === "tool_execution_end" &&
                    !action.ev.isError &&
                    isAskUserStyleTool(action.ev.toolName)
                ) {
                    const toolCallId = endedToolCallId ?? "";
                    const details = action.ev.result?.details as { waiting?: boolean } | undefined;
                    askUserPending =
                        details?.waiting === true
                            ? { ...askUserPending, [toolCallId]: true }
                            : omitKey(askUserPending, toolCallId);
                }
                // Clear agentToolPending on any agent / skill end, keyed directly by
                // toolCallId. The previous subagentSpawned reverse-lookup leaked whenever
                // that frame was lost or arrived late — the tool finished but pending never
                // cleared, leaving the composer disabled forever.
                const clearsAgentPending =
                    action.ev.type === "tool_execution_end" &&
                    (action.ev.toolName === "agent" || action.ev.toolName === "skill");
                return {
                    messages: result.messages,
                    pendingBySessionId: result.clearPending
                        ? { ...existing.pendingBySessionId, [action.sid]: false }
                        : existing.pendingBySessionId,
                    askUserPending,
                    agentToolPending: clearsAgentPending
                        ? omitKey(existing.agentToolPending, endedToolCallId ?? "")
                        : existing.agentToolPending,
                };
            });
        case "SUBAGENT_SPAWNED":
            return updateWs(state, action.cwd, (existing) => ({
                messages: backfillSubagentDetails(
                    existing.messages,
                    action.parentToolCallId,
                    action.subSessionId,
                    action.agentType,
                ),
                subagentSpawned: {
                    ...existing.subagentSpawned,
                    [subagentKey(action.parentSessionId, action.parentToolCallId)]: {
                        subSessionId: action.subSessionId,
                        agentType: action.agentType,
                        parentToolCallId: action.parentToolCallId,
                    },
                },
                agentToolPending: {
                    ...existing.agentToolPending,
                    [action.parentToolCallId]: true,
                },
            }));
        case "CHILD_MESSAGE_EVENT":
            return updateWs(state, action.cwd, (existing) => ({
                childMessagesBySubSessionId: {
                    ...existing.childMessagesBySubSessionId,
                    [action.subSessionId]: applyEventToMessages(
                        existing.childMessagesBySubSessionId[action.subSessionId] ?? [],
                        action.ev,
                        { suppressedThinking: action.suppressedThinking, now: action.now },
                    ).messages,
                },
            }));
        case "LOAD_SUBAGENT_HISTORY":
            return updateWs(state, action.cwd, (existing) => ({
                childHistoryLoaded: {
                    ...existing.childHistoryLoaded,
                    [action.subSessionId]: action.messages,
                },
            }));
        case "RESTORE_SESSION_SNAPSHOT":
            return updateWs(state, action.cwd, (existing) => {
                if (action.sessionKind === "subagent") {
                    return {
                        childMessagesBySubSessionId: {
                            ...existing.childMessagesBySubSessionId,
                            [action.sid]: action.messages,
                        },
                        childHistoryLoaded: {
                            ...existing.childHistoryLoaded,
                            [action.sid]: action.messages,
                        },
                    };
                }
                if (existing.activeSession !== action.sid) return undefined;
                const askUserPending: Record<string, true> = {};
                for (const id of action.pendingAskUserIds ?? []) askUserPending[id] = true;
                return {
                    messages: action.messages,
                    askUserPending,
                    pendingBySessionId: { ...existing.pendingBySessionId, [action.sid]: false },
                };
            });
        case "ASKUSER_ANSWERED":
            return updateWs(state, action.cwd, (existing) => ({
                askUserPending: omitKey(existing.askUserPending, action.toolCallId),
                messages: attachAskUserAnswers(
                    existing.messages,
                    action.toolCallId,
                    action.answers,
                ),
            }));
        case "TASKS_UPDATED":
            return updateWs(state, action.cwd, (existing) => ({
                taskSnapshotsBySessionId: {
                    ...existing.taskSnapshotsBySessionId,
                    [action.sid]: {
                        active: action.active,
                        history: action.history,
                        updatedAt: Date.now(),
                    },
                },
            }));
        case "PLAN_STATE_UPDATED":
            return updateWs(state, action.cwd, (existing) => ({
                planStatesBySessionId: {
                    ...existing.planStatesBySessionId,
                    [action.sid]: { active: action.active, currentSlug: action.currentSlug },
                },
            }));
        case "HISTORY_DETAIL_LOADED":
            return updateWs(state, action.cwd, (existing) => ({
                historyDetailsBySessionId: {
                    ...existing.historyDetailsBySessionId,
                    [action.sid]: {
                        ...(existing.historyDetailsBySessionId[action.sid] ?? {}),
                        [action.listId]: { tasks: action.tasks, loadedAt: Date.now() },
                    },
                },
            }));
        case "TASK_PANEL_FORCE_EXPAND":
            return updateWs(state, action.cwd, () => ({ forceExpandTaskPanel: true }));
        case "TASK_PANEL_FORCE_EXPAND_CONSUMED":
            return updateWs(state, action.cwd, (existing) =>
                existing.forceExpandTaskPanel ? { forceExpandTaskPanel: false } : undefined,
            );
        case "BEGIN_PENDING_NEW_SESSION":
            // Same reset shape as ATTACH's switch branch (subagent state, child streams,
            // askUser/agent-tool pendings): the new session must not inherit anything
            // from the previous one. The sessions list is kept so sidebar entries remain
            // and the user can re-attach to a prior chat. pendingBySessionId is per-sid,
            // so a late turn_end from the abandoned session hits the activeSession guard
            // in APPLY_EVENT and is dropped — clearing the whole map cannot resurrect it.
            return updateWs(state, action.cwd, () => ({
                activeSession: undefined,
                messages: [],
                subagentSpawned: {},
                childMessagesBySubSessionId: {},
                childHistoryLoaded: {},
                askUserPending: {},
                agentToolPending: {},
                pendingBySessionId: {},
            }));
    }
}
