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
import {
    extractAssistantTextAndThinking,
    type SessionEventLike,
    type UiMessage,
} from "./chatUtils";

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
     * cwd → true: TaskPanel should be force-expanded (dispatched synchronously by
     * useSidecarStream when it first writes a task snapshot for a sid). Cleared by
     * CONSUMED after TaskPanel reads it. Not persisted, no cross-cwd leakage.
     */
    forceExpandTaskPanelByCwd: Record<string, true>;
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
        forceExpandTaskPanelByCwd: {},
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
          /** Workspace path; if omitted, the reducer scans for the workspace holding this toolCallId. */
          cwd?: string;
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
        case "SIDECAR_RESTARTED": {
            // Only shell tools are expired here. askUser / planExit have their
            // own history-recovery path, agent subagents are recovered via
            // snapshot, and other tools are out of scope for this fix.
            const markFailed = <T extends { name: string; status: string; details?: unknown }>(
                tool: T,
            ): T =>
                tool.name === "shell" && tool.status === "running"
                    ? {
                          ...tool,
                          status: "error" as const,
                          details: {
                              ...((tool.details ?? {}) as object),
                              reason: "sidecar_restarted",
                              exitCode: -1,
                              interrupted: false,
                          },
                      }
                    : tool;
            const existing = state[action.cwd];
            if (!existing) return state;
            const messages = existing.messages.map((message) => {
                if (message.kind !== "assistant") return message;
                return { ...message, tools: message.tools.map(markFailed) };
            });
            const childMessagesBySubSessionId: typeof existing.childMessagesBySubSessionId = {};
            for (const [subSid, childMessages] of Object.entries(
                existing.childMessagesBySubSessionId ?? {},
            )) {
                childMessagesBySubSessionId[subSid] = childMessages.map((message) => {
                    if (message.kind !== "assistant") return message;
                    return { ...message, tools: message.tools.map(markFailed) };
                });
            }
            return {
                ...state,
                [action.cwd]: { ...existing, messages, childMessagesBySubSessionId },
            };
        }
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
        case "ADD_SESSION": {
            const existing = state[action.cwd];
            if (!existing) return state;
            const sid = action.session.id;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    sessions: sortSessionsByUpdatedDesc([
                        ...(existing.sessions ?? []),
                        action.session,
                    ]),
                    activeSession: action.makeActive === false ? existing.activeSession : sid,
                },
            };
        }
        case "ATTACH": {
            const existing = state[action.cwd];
            if (!existing) return state;
            // Same-session re-attach: keep the in-flight subagent live stream intact.
            // Only clear on switch to a different session (parent-child relation only
            // applies to the current parent session).
            if (existing.activeSession === action.sid) {
                return state;
            }
            // Restore pending for askUser toolCallIds still waiting in history so card
            // selection can resume the turn. The injection trigger is the pending
            // "true → false" transition; without restore, historical askUser clicks are dead.
            const restoredPending: Record<string, true> = {};
            for (const id of action.pendingAskUserIds ?? []) restoredPending[id] = true;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    activeSession: action.sid,
                    messages: action.messages,
                    subagentSpawned: {},
                    childMessagesBySubSessionId: {},
                    childHistoryLoaded: {},
                    askUserPending: restoredPending,
                    agentToolPending: {},
                },
            };
        }
        case "ATTACHED_PUSH": {
            const existing = state[action.cwd];
            if (!existing) return state;
            // activeSession is set uniformly by the ATTACH action (with history). This
            // push is just sidecar's ack for session.attach; overwriting activeSession
            // here would short-circuit the subsequent ATTACH (same-session) and drop
            // history — causing blank first-open or stale messages on new sessions.
            return state;
        }
        case "COMMAND_PERMISSION_REQUESTED": {
            const existing = state[action.cwd];
            if (!existing || existing.activeSession !== action.sid) return state;
            let found = false;
            const matchTcid = action.request.displayToolCallId ?? action.request.toolCallId;
            const messages = existing.messages.map((message) => {
                if (message.kind !== "assistant") return message;
                const toolIndex = message.tools.findIndex((tool) => tool.id === matchTcid);
                if (toolIndex < 0) return message;
                found = true;
                const tools = [...message.tools];
                const tool = tools[toolIndex];
                if (!tool) return message;
                tools[toolIndex] = {
                    ...tool,
                    details: { ...(tool.details as object), commandPermission: action.request },
                };
                return { ...message, tools };
            });
            if (!found) return state;
            return { ...state, [action.cwd]: { ...existing, messages } };
        }
        case "REMOVE_SESSION": {
            const existing = state[action.cwd];
            if (!existing) return state;
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
            const { [action.sid]: _drop, ...remainingPending } = existing.pendingBySessionId;
            void _drop;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    sessions: remaining,
                    listCursor: clearedCursor,
                    ...(existing.listTotal !== undefined
                        ? { listTotal: Math.max(0, existing.listTotal - 1) }
                        : {}),
                    ...(wasActive ? { activeSession: undefined, messages: [] } : {}),
                    pendingBySessionId: remainingPending,
                },
            };
        }
        case "SET_PENDING": {
            const existing = state[action.cwd];
            if (!existing) return state;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    pendingBySessionId: {
                        ...existing.pendingBySessionId,
                        [action.sid]: action.pending,
                    },
                },
            };
        }
        case "BUMP_SESSION_TIME": {
            const existing = state[action.cwd];
            if (!existing) return state;
            const target = existing.sessions.find((s) => s.id === action.sid);
            if (!target) return state;
            const updated = { ...target, updatedAt: action.updatedAt };
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    sessions: sortSessionsByUpdatedDesc(
                        existing.sessions.map((s) => (s.id === action.sid ? updated : s)),
                    ),
                },
            };
        }
        case "APPEND_SYSTEM": {
            const existing = state[action.cwd];
            if (!existing || existing.activeSession !== action.sid) return state;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    messages: [...existing.messages, action.msg],
                    pendingBySessionId: { ...existing.pendingBySessionId, [action.sid]: false },
                },
            };
        }
        case "APPEND_ASSISTANT_FINAL": {
            const existing = state[action.cwd];
            if (!existing || existing.activeSession !== action.sid) return state;
            // Final assistant message returned synchronously by sessionCreate / sessionPrompt.
            // Previously dropped outright, which left an empty bubble + pending=false when the
            // LLM errored immediately. Now extract text + thinking via extractAssistantTextAndThinking;
            // if stopReason === "error", render a system-style message from errorMessage.
            const m = action.reply as AgentMessage & {
                stopReason?: string;
                errorMessage?: string;
            };
            const { text, thinking } = extractAssistantTextAndThinking(m);
            const isError = m.stopReason === "error";
            const errorText = isError ? (m.errorMessage ?? "Assistant error") : null;
            const next_msgs: UiMessage[] = [...existing.messages];
            // Fallback: if message_start already created a same-id bubble, overwrite it; otherwise append a new assistant message.
            const ts = String((m as { timestamp?: unknown }).timestamp ?? Date.now());
            const id = `final-asst-${ts}`;
            const liveIdx = next_msgs.findIndex(
                (x) => x.kind === "assistant" && x.id === `live-asst-${ts}`,
            );
            if (liveIdx >= 0) {
                // Shallow-clone the bubble before overwriting — never mutate next_msgs[liveIdx]
                // in place; it shares the reference with existing.messages[liveIdx], so direct
                // assignment would pollute the input state.
                const live = next_msgs[liveIdx] as Extract<UiMessage, { kind: "assistant" }>;
                next_msgs[liveIdx] = { ...live, text, thinking };
            } else {
                next_msgs.push({
                    id,
                    kind: "assistant",
                    text,
                    ts: Date.now(),
                    tools: [],
                    thinking,
                });
            }
            if (errorText) {
                next_msgs.push({
                    id: `${id}-err`,
                    kind: "system",
                    text: `⚠ ${errorText}`,
                    ts: Date.now(),
                });
            }
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    messages: next_msgs,
                    pendingBySessionId: { ...existing.pendingBySessionId, [action.sid]: false },
                },
            };
        }
        case "APPEND_USER": {
            const existing = state[action.cwd];
            if (!existing) return state;
            // Optimistic user message: id is "optimistic-user-${ts}" so the
            // server push handler (applyEventToMessages.handleMessageEnd) can
            // recognise it later and replace it with the server-timestamped
            // entry instead of duplicating. See APPEND_USER's JSDoc.
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    messages: [...existing.messages, action.msg],
                },
            };
        }
        case "APPLY_EVENT": {
            const existing = state[action.cwd];
            // The shared messages array renders activeSession; background-session stream
            // events must be dropped, otherwise they bleed into the currently displayed
            // session (rebuilt from sessionEventLog / snapshot on switch-back).
            if (!existing || existing.activeSession !== action.sid) return state;

            const result = applyEventToMessages(existing.messages, action.ev, {
                suppressedThinking: action.suppressedThinking,
                now: action.now,
            });

            // askUser tool: tool_execution_end + waiting === true → mark pending;
            // waiting !== true → clear pending.
            // Note: both tool_execution_end details write to the same tool card (same toolCallId);
            // applyEventToMessages upserts, so the second details has no questions. When clearing
            // pending, questions must be reverse-read from the tool card in current messages.
            let nextAskUserPending = existing.askUserPending;
            // askUser / planExit share the same trigger: terminate + questions + waiting (two-state).
            // toolName / isError live on the tool_execution_end branch of the
            // SessionEventLike union; access them only after the type guard so
            // TS narrows correctly.
            if (
                action.ev.type === "tool_execution_end" &&
                !action.ev.isError &&
                isAskUserStyleTool(action.ev.toolName)
            ) {
                const toolCallId = action.ev.toolCallId ?? "";
                const details = action.ev.result?.details as { waiting?: boolean } | undefined;
                if (details?.waiting === true) {
                    nextAskUserPending = { ...existing.askUserPending, [toolCallId]: true };
                } else if (toolCallId in existing.askUserPending) {
                    // Second askUser/planExit (waiting=false) clears pending;
                    // questions/answers are already merged and retained by applyEventToMessages, no work here.
                    const { [toolCallId]: _, ...rest } = existing.askUserPending;
                    nextAskUserPending = rest;
                }
            }

            // agent tool: on tool_execution_end (agent), clear the corresponding agentToolPending entry.
            // Reverse-lookup subSessionId → parentToolCallId via subagentSpawned, then remove from agentToolPending.
            let nextAgentToolPending = existing.agentToolPending;
            if (action.ev.type === "tool_execution_end") {
                const toolCallId = action.ev.toolCallId ?? "";
                // Clear pending for any agent / skill tool end. The previous
                // spawnedByAgent reverse-lookup left a leak when the
                // subagentSpawned frame was lost or arrived after tool_execution_end
                // — the agent tool finished but pending never cleared, leaving the
                // composer disabled forever. Now any agent end (error or not) and
                // any skill end clears the entry directly by toolCallId.
                const clearAgentPending =
                    action.ev.toolName === "agent" || action.ev.toolName === "skill";
                if (clearAgentPending && toolCallId in existing.agentToolPending) {
                    const { [toolCallId]: _, ...rest } = existing.agentToolPending;
                    nextAgentToolPending = rest;
                }
            }

            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    messages: result.messages,
                    pendingBySessionId: result.clearPending
                        ? { ...existing.pendingBySessionId, [action.sid]: false }
                        : existing.pendingBySessionId,
                    askUserPending: nextAskUserPending,
                    agentToolPending: nextAgentToolPending,
                },
            };
        }
        case "SUBAGENT_SPAWNED": {
            const existing = state[action.cwd];
            if (!existing) return state;
            const key = subagentKey(action.parentSessionId, action.parentToolCallId);
            // Backfill the agent card's `details.subSessionId` so the expanded
            // view can bind the live child stream while the subagent is still
            // running. `details` normally only arrives on tool_execution_end —
            // until then the card renders "spawning…" even though the child
            // stream is already accumulating under `childMessagesBySubSessionId`.
            let messages = existing.messages;
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.kind !== "assistant") continue;
                const toolIdx = m.tools.findIndex((t) => t.id === action.parentToolCallId);
                if (toolIdx < 0) continue;
                messages = messages.slice();
                messages[i] = {
                    ...m,
                    tools: m.tools.map((t, j) =>
                        j === toolIdx
                            ? {
                                  ...t,
                                  details: {
                                      ...((t.details ?? {}) as Record<string, unknown>),
                                      subSessionId: action.subSessionId,
                                      ...(action.agentType ? { agentType: action.agentType } : {}),
                                  },
                              }
                            : t,
                    ),
                };
                break;
            }
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    messages,
                    subagentSpawned: {
                        ...existing.subagentSpawned,
                        [key]: {
                            subSessionId: action.subSessionId,
                            agentType: action.agentType,
                            parentToolCallId: action.parentToolCallId,
                        },
                    },
                    agentToolPending: {
                        ...existing.agentToolPending,
                        [action.parentToolCallId]: true,
                    },
                },
            };
        }
        case "CHILD_MESSAGE_EVENT": {
            const existing = state[action.cwd];
            if (!existing) return state;
            const prev = existing.childMessagesBySubSessionId[action.subSessionId] ?? [];
            const result = applyEventToMessages(prev, action.ev, {
                suppressedThinking: action.suppressedThinking,
                now: action.now,
            });
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    childMessagesBySubSessionId: {
                        ...existing.childMessagesBySubSessionId,
                        [action.subSessionId]: result.messages,
                    },
                },
            };
        }
        case "LOAD_SUBAGENT_HISTORY": {
            const existing = state[action.cwd];
            if (!existing) return state;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    childHistoryLoaded: {
                        ...existing.childHistoryLoaded,
                        [action.subSessionId]: action.messages,
                    },
                },
            };
        }
        case "RESTORE_SESSION_SNAPSHOT": {
            const existing = state[action.cwd];
            if (!existing) return state;
            if (action.sessionKind === "subagent") {
                return {
                    ...state,
                    [action.cwd]: {
                        ...existing,
                        childMessagesBySubSessionId: {
                            ...existing.childMessagesBySubSessionId,
                            [action.sid]: action.messages,
                        },
                        childHistoryLoaded: {
                            ...existing.childHistoryLoaded,
                            [action.sid]: action.messages,
                        },
                    },
                };
            }
            if (existing.activeSession !== action.sid) return state;
            const askUserPending: Record<string, true> = {};
            for (const id of action.pendingAskUserIds ?? []) askUserPending[id] = true;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    messages: action.messages,
                    askUserPending,
                    pendingBySessionId: { ...existing.pendingBySessionId, [action.sid]: false },
                },
            };
        }
        case "ASKUSER_ANSWERED": {
            const patchMessages = (messages: UiMessage[]): UiMessage[] => {
                return messages.map((msg) => {
                    if (msg.kind !== "assistant") return msg;
                    const idx = (msg as Extract<UiMessage, { kind: "assistant" }>).tools.findIndex(
                        (t) => t.id === action.toolCallId,
                    );
                    if (idx < 0) return msg;
                    const tool = (msg as Extract<UiMessage, { kind: "assistant" }>).tools[idx];
                    const updatedTool = {
                        ...tool,
                        details: {
                            ...(tool.details as Record<string, unknown>),
                            answers: action.answers,
                        },
                    };
                    const nextTools = [...(msg as Extract<UiMessage, { kind: "assistant" }>).tools];
                    nextTools[idx] = updatedTool;
                    return { ...msg, tools: nextTools };
                });
            };
            if (action.cwd) {
                const existing = state[action.cwd];
                if (!existing) return state;
                const { [action.toolCallId]: _, ...rest } = existing.askUserPending;
                return {
                    ...state,
                    [action.cwd]: {
                        ...existing,
                        askUserPending: rest,
                        messages: patchMessages(existing.messages),
                    },
                };
            }
            // cwd omitted: scan all workspaces for the one holding this toolCallId pending.
            for (const cwd of Object.keys(state)) {
                const ws = state[cwd];
                if (ws?.askUserPending[action.toolCallId]) {
                    const { [action.toolCallId]: _, ...rest } = ws.askUserPending;
                    return {
                        ...state,
                        [cwd]: {
                            ...ws,
                            askUserPending: rest,
                            messages: patchMessages(ws.messages),
                        },
                    };
                }
            }
            return state;
        }
        case "TASKS_UPDATED": {
            const existing = state[action.cwd];
            if (!existing) return state;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    taskSnapshotsBySessionId: {
                        ...existing.taskSnapshotsBySessionId,
                        [action.sid]: {
                            active: action.active,
                            history: action.history,
                            updatedAt: Date.now(),
                        },
                    },
                },
            };
        }
        case "PLAN_STATE_UPDATED": {
            const existing = state[action.cwd];
            if (!existing) return state;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    planStatesBySessionId: {
                        ...existing.planStatesBySessionId,
                        [action.sid]: { active: action.active, currentSlug: action.currentSlug },
                    },
                },
            };
        }
        case "HISTORY_DETAIL_LOADED": {
            const existing = state[action.cwd];
            if (!existing) return state;
            const prevSession = existing.historyDetailsBySessionId[action.sid] ?? {};
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    historyDetailsBySessionId: {
                        ...existing.historyDetailsBySessionId,
                        [action.sid]: {
                            ...prevSession,
                            [action.listId]: { tasks: action.tasks, loadedAt: Date.now() },
                        },
                    },
                },
            };
        }
        case "TASK_PANEL_FORCE_EXPAND": {
            const existing = state[action.cwd];
            if (!existing) return state;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    forceExpandTaskPanelByCwd: {
                        ...existing.forceExpandTaskPanelByCwd,
                        [action.cwd]: true,
                    },
                },
            };
        }
        case "TASK_PANEL_FORCE_EXPAND_CONSUMED": {
            const existing = state[action.cwd];
            if (!existing) return state;
            const { [action.cwd]: _, ...rest } = existing.forceExpandTaskPanelByCwd;
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    forceExpandTaskPanelByCwd: rest,
                },
            };
        }
        case "BEGIN_PENDING_NEW_SESSION": {
            const existing = state[action.cwd];
            if (!existing) return state;
            // Same reset shape as ATTACH's switch branch (subagent state, child streams,
            // askUser/agent-tool pendings): the new session must not inherit anything
            // from the previous one. The sessions list is kept so sidebar entries remain
            // and the user can re-attach to a prior chat. pendingBySessionId is per-sid,
            // so a late turn_end from the abandoned session hits the activeSession guard
            // in APPLY_EVENT and is dropped — clearing the whole map cannot resurrect it.
            return {
                ...state,
                [action.cwd]: {
                    ...existing,
                    activeSession: undefined,
                    messages: [],
                    subagentSpawned: {},
                    childMessagesBySubSessionId: {},
                    childHistoryLoaded: {},
                    askUserPending: {},
                    agentToolPending: {},
                    pendingBySessionId: {},
                },
            };
        }
    }
}
