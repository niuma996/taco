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

/**
 * Lifecycle of an `agent` call launched with `background: true`. Named because
 * the subagent panel derives from it too — see `WorkspaceState.backgroundSubagents`.
 * `aborted` is a deliberate stop (panel stop button / `agentAbort` / wall-clock
 * timeout), deliberately distinct from `error`.
 */
export type BackgroundSubagentState = "running" | "completed" | "error" | "aborted";

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
     * Driven by run_start / run_end events (not turn_end — that fires at every
     * mid-run tool-batch boundary); SET_PENDING stays as the optimistic /
     * RPC-settle override.
     */
    pendingBySessionId: Record<string, boolean>;
    /**
     * sessionId → steering messages waiting in the lane's inbox (steer /
     * followUp / nextRun). Replaced wholesale by each queue_update; drained
     * by operation_abort. Optimistic rows (APPEND_QUEUED) survive until the
     * server's list echoes the same kind + text.
     */
    queuedBySessionId: Record<string, QueuedUiItem[]>;
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
     * applyEventToMessages). Set when tool_end has details.waiting === true;
     * cleared by ASKUSER_ANSWERED. Also applies to planExit: reducer treats it as an
     * askUser-style two-state tool (first waiting=true, second answered).
     */
    askUserPending: Record<string, true>;
    /**
     * requestId → the shell approval still awaiting a decision.
     *
     * Not derivable from a tool card: a background spawn's card settles to `ok`
     * the moment it launches, so its status says nothing about whether the child
     * is now blocked waiting for the user. Entries must survive a session switch
     * — a background child runs for minutes — so this is workspace-scoped, not
     * stored in the active session's messages alone.
     */
    pendingCommandPermissions: Record<string, CommandPermissionRequest>;
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
     * parentToolCallId → true tracks agent tool calls awaiting subagent results.
     * Written by SUBAGENT_SPAWNED; cleared by the corresponding tool_end (agent).
     * Used by UI to block sending: pending is false but a subagent running should still block.
     *
     * Background spawns are deliberately excluded — see `backgroundSubagents`.
     */
    agentToolPending: Record<string, true>;
    /**
     * parentToolCallId → lifecycle of an `agent` call launched with
     * `background: true`.
     *
     * A background spawn's `tool_end` fires at launch, so it cannot mean "the
     * child finished" the way a synchronous one does. Two things follow.
     *
     * First, its `subagent.spawned` arrives *after* that `tool_end`, which used
     * to re-set `agentToolPending` with nothing left to clear it — leaving the
     * composer idle but the Stop button stuck on screen forever. Recording the
     * launch here lets SUBAGENT_SPAWNED skip the pending write: the whole point
     * of a background spawn is that the parent keeps working, so it must not
     * make the session look busy.
     *
     * Second, the tool call's own status is `ok` from the moment it launches, so
     * the subagent panel cannot derive liveness from it. `"running"` here is
     * what tells the panel the child is still working; SUBAGENT_SETTLED replaces
     * it with the real outcome rather than deleting it, because the panel still
     * has to render a finished background child.
     */
    backgroundSubagents: Record<string, BackgroundSubagentState>;
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
                    // The dead daemon's broker took its pending requests with it,
                    // and no resolved push will ever arrive for them.
                    pendingCommandPermissions: {},
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
                // Same-session re-attach: keep the in-flight subagent live stream
                // intact. The one piece worth refreshing is backgroundSubagents —
                // after a sidecar restart the live map is stale (a child the old
                // process ran shows "running" forever), and the attach response's
                // fresh in-flight + settled signals are the only correction.
                if (existing.activeSession === action.sid) {
                    if (
                        action.inFlightAgentToolCallIds === undefined &&
                        action.settledBackgroundSubSessionIds === undefined
                    ) {
                        return undefined;
                    }
                    const rebuilt = rebuildBackgroundSubagents(
                        action.messages,
                        action.inFlightAgentToolCallIds,
                        action.settledBackgroundSubSessionIds,
                    );
                    // Existing terminal outcomes win: they came from
                    // SUBAGENT_SETTLED, which knows the real outcome, while the
                    // rebuild can only say "completed" for any settled child.
                    // Entries missing from the rebuild keep their value.
                    const merged = { ...existing.backgroundSubagents, ...rebuilt };
                    for (const [id, s] of Object.entries(existing.backgroundSubagents)) {
                        if (s !== "running") merged[id] = s;
                    }
                    return sameBackgroundStates(merged, existing.backgroundSubagents)
                        ? undefined
                        : { backgroundSubagents: merged };
                }
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
                    backgroundSubagents: rebuildBackgroundSubagents(
                        action.messages,
                        action.inFlightAgentToolCallIds,
                        action.settledBackgroundSubSessionIds,
                    ),
                };
            });
        case "ATTACHED_PUSH":
            // activeSession is set uniformly by the ATTACH action (with history). This
            // push is just sidecar's ack for session.attach; overwriting activeSession
            // here would short-circuit the subsequent ATTACH (same-session) and drop
            // history — causing blank first-open or stale messages on new sessions.
            return state;
        case "COMMAND_PERMISSION_REQUESTED":
            return updateWs(
                state[action.cwd]
                    ? state
                    : { ...state, [action.cwd]: createEmptyWorkspace(action.cwd) },
                action.cwd,
                (existing) => ({
                    pendingCommandPermissions: {
                        ...existing.pendingCommandPermissions,
                        [action.request.requestId]: action.request,
                    },
                    // Only the session on screen has messages to patch. The entry above is
                    // written regardless, so a session switch can no longer strand a
                    // request that is still holding a subagent's shell call open.
                    messages:
                        existing.activeSession === action.sid
                            ? attachCommandPermission(existing.messages, action.request)
                            : existing.messages,
                }),
            );
        case "COMMAND_PERMISSION_RESOLVED":
            return updateWs(state, action.cwd, (existing) => ({
                pendingCommandPermissions: omitKey(
                    existing.pendingCommandPermissions,
                    action.requestId,
                ),
            }));
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
                    queuedBySessionId: omitKey(existing.queuedBySessionId, action.sid),
                    // The broker aborts these server-side, but the resolved push is
                    // routed to the session being removed and may never be applied.
                    pendingCommandPermissions: omitRequestsForSession(
                        existing.pendingCommandPermissions,
                        action.sid,
                    ),
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
        case "SESSION_RENAMED":
            // Patches the sidebar title in place for an async rename (currently only the
            // one-shot LLM title summary — see `session.renamed` push doc). No re-sort:
            // a title change alone doesn't affect updatedAt-based ordering.
            return updateWs(state, action.cwd, (existing) => {
                const target = existing.sessions.find((s) => s.id === action.sid);
                if (!target) return undefined;
                return {
                    sessions: existing.sessions.map((s) =>
                        s.id === action.sid ? { ...s, name: action.name } : s,
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
        case "APPEND_QUEUED":
            return updateWs(state, action.cwd, (existing) => ({
                queuedBySessionId: {
                    ...existing.queuedBySessionId,
                    [action.sid]: [...(existing.queuedBySessionId[action.sid] ?? []), action.item],
                },
            }));
        case "REMOVE_QUEUED":
            return updateWs(state, action.cwd, (existing) => {
                const prev = existing.queuedBySessionId[action.sid];
                if (!prev?.some((q) => q.id === action.id)) return undefined;
                const remaining = prev.filter((q) => q.id !== action.id);
                return {
                    queuedBySessionId:
                        remaining.length > 0
                            ? { ...existing.queuedBySessionId, [action.sid]: remaining }
                            : omitKey(existing.queuedBySessionId, action.sid),
                };
            });
        case "APPLY_EVENT":
            return updateWs(state, action.cwd, (existing) => {
                // Run lifecycle + steering-queue state are keyed per session and
                // drive the sidebar status dot / queue strip, so they update for
                // background sessions too — before the activeSession guard below.
                // Only run boundaries flip pending: `turn_end` fires mid-run at
                // every tool-batch / response boundary (a steered turn extends
                // the same run), so it must not be treated as "the turn is over".
                let pendingBySessionId = existing.pendingBySessionId;
                if (action.ev.type === "run_start") {
                    pendingBySessionId = { ...pendingBySessionId, [action.sid]: true };
                } else if (action.ev.type === "run_end") {
                    // Completed / aborted / failed all mean the operation left the lane.
                    pendingBySessionId = { ...pendingBySessionId, [action.sid]: false };
                }
                // Steering queue: queue_update replaces the server-owned rows,
                // operation_abort drains everything. Neither touches messages.
                //
                // Optimistic rows are deliberately left alone here. pi emits
                // queue_update from inside the lane command, before the enqueue
                // RPC returns, so the server row for a message normally arrives
                // while that message's own optimistic row is still pending —
                // dropping optimistic rows on any server list would retire them
                // a beat early, and matching them by text would conflate two
                // identical steers. REMOVE_QUEUED retires them instead, keyed by
                // the id the RPC caller holds.
                let queuedBySessionId = existing.queuedBySessionId;
                if (action.ev.type === "queue_update") {
                    const prev = existing.queuedBySessionId[action.sid] ?? [];
                    const next = [
                        ...prev.filter((q) => q.optimistic),
                        ...queuedItemsFromEvent(action.ev),
                    ];
                    queuedBySessionId =
                        next.length > 0
                            ? { ...existing.queuedBySessionId, [action.sid]: next }
                            : omitKey(existing.queuedBySessionId, action.sid);
                } else if (action.ev.type === "operation_abort") {
                    queuedBySessionId = omitKey(existing.queuedBySessionId, action.sid);
                }
                // The shared messages array renders activeSession; background-session stream
                // events must be dropped, otherwise they bleed into the currently displayed
                // session (rebuilt from sessionEventLog / snapshot on switch-back).
                if (existing.activeSession !== action.sid) {
                    if (
                        pendingBySessionId === existing.pendingBySessionId &&
                        queuedBySessionId === existing.queuedBySessionId
                    ) {
                        return undefined;
                    }
                    return { pendingBySessionId, queuedBySessionId };
                }
                const result = applyEventToMessages(existing.messages, action.ev, {
                    suppressedThinking: action.suppressedThinking,
                    now: action.now,
                });
                // toolName / isError / toolCallId live on the tool_end branch of
                // the SessionEventLike union; access them only after the type guard so TS
                // narrows correctly.
                const endedToolCallId =
                    action.ev.type === "tool_end" ? (action.ev.toolCallId ?? "") : null;
                let askUserPending = existing.askUserPending;
                // askUser / planExit share the same trigger: terminate + questions + a
                // two-state waiting flag. Both tool_end frames write the same
                // tool card, so the second one carries no questions — clearing pending
                // relies on applyEventToMessages having already merged them.
                if (
                    action.ev.type === "tool_end" &&
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
                    action.ev.type === "tool_end" &&
                    (action.ev.toolName === "agent" || action.ev.toolName === "skill");
                // `status: "launched"` means this tool_end is a background spawn's
                // launch receipt, not a finished child. Record it so the
                // SUBAGENT_SPAWNED that lands next does not mark the session busy.
                const isBackgroundLaunch =
                    action.ev.type === "tool_end" &&
                    action.ev.toolName === "agent" &&
                    isBackgroundLaunchDetails(action.ev.result?.details);
                return {
                    messages: result.messages,
                    pendingBySessionId,
                    askUserPending,
                    agentToolPending: clearsAgentPending
                        ? omitKey(existing.agentToolPending, endedToolCallId ?? "")
                        : existing.agentToolPending,
                    backgroundSubagents:
                        isBackgroundLaunch && endedToolCallId
                            ? { ...existing.backgroundSubagents, [endedToolCallId]: "running" }
                            : existing.backgroundSubagents,
                    queuedBySessionId,
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
                // A background spawn's launch receipt already landed as tool_end
                // before this frame, so writing pending here would strand it:
                // nothing clears it, and the composer goes idle with the Stop
                // button still showing. Background children keep the session
                // usable by design.
                agentToolPending:
                    existing.backgroundSubagents[action.parentToolCallId] !== undefined
                        ? existing.agentToolPending
                        : {
                              ...existing.agentToolPending,
                              [action.parentToolCallId]: true,
                          },
            }));
        case "SUBAGENT_SETTLED":
            return updateWs(state, action.cwd, (existing) => ({
                agentToolPending: omitKey(existing.agentToolPending, action.parentToolCallId),
                // Outcome recorded, not deleted: the panel still renders this
                // child, and its tool call has said `ok` since launch, so this
                // is the only place the real result is known.
                backgroundSubagents: {
                    ...existing.backgroundSubagents,
                    [action.parentToolCallId]: action.outcome,
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
                    // A restore is about messages, not liveness — run_start /
                    // run_end own this flag. Re-attaching to a session whose
                    // turn is still in flight (switch away mid-run and back, or
                    // a reload) must not mark it stopped, so seed `false` only
                    // when nothing is known about this session yet. Without
                    // this, a long tool call — e.g. a Claude Code subagent
                    // running for minutes — shows as finished while it works.
                    pendingBySessionId: {
                        ...existing.pendingBySessionId,
                        [action.sid]: existing.pendingBySessionId[action.sid] ?? false,
                    },
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
        case "BEGIN_PENDING_NEW_SESSION":
            // Same reset shape as ATTACH's switch branch (subagent state, child streams,
            // askUser/agent-tool pendings): the new session must not inherit anything
            // from the previous one. The sessions list is kept so sidebar entries remain
            // and the user can re-attach to a prior chat.
            //
            // pendingBySessionId / queuedBySessionId are deliberately kept. They are
            // keyed per session id, so nothing in them can leak into the new session,
            // and starting a new chat does not stop the old one — its run keeps going
            // on the server. Clearing them dropped that session's running mark, and
            // nothing put it back: run lifecycle events update these maps before the
            // activeSession guard, but `run_start` has already fired, so the sidebar
            // dot and the stop button read "idle" until the run ended.
            return updateWs(state, action.cwd, () => ({
                activeSession: undefined,
                messages: [],
                subagentSpawned: {},
                childMessagesBySubSessionId: {},
                childHistoryLoaded: {},
                askUserPending: {},
                agentToolPending: {},
                backgroundSubagents: {},
            }));
    }
}
