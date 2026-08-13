/**
 * Push event types — PushMethods registry + payload shapes for compaction,
 * tasks, plan state, tool call streaming, subagent spawning. Pulled by
 * session.ts (TasksUpdatedParams/PlanStateUpdatedParams) for snapshot Pick.
 */

import type { ChannelStatusChangedParams } from "./channels.js";
import type {
    CompactionFailureReason,
    SessionId,
    SidecarHelloParams,
    WorkspaceId,
} from "./frames.js";

// Push event payloads

/*
 * `PushMethods` categories — stable wire strings, never renamed or reused.
 * - streaming/lifecycle: `session.event`, `session.tool_call_*`,
 *   `session.attached`/`_detached`/`_error`/`_deleted`,
 *   `session.compaction_started` / `_finished`
 * - workspace-dimension: `sidecar.hello`, `models.changed`,
 *   `channel.status_changed`, `channels.conversations_changed`
 * - reverse-request: `command_permission.requested`, `subagent.spawned`,
 *   invalidate: `tasks.updated`, `plan.state.updated`
 */

/*
 * Rules for new entries: future streaming events (thought, diff, plan-stream,
 * terminal output) MUST become `session.event` subtypes rather than new
 * top-level methods — the registry only grows for the other four categories,
 * which cross the session boundary. The current 16 entries are not
 * consolidated and no generic `session.update` umbrella is introduced.
 * Known gap: `session.detached` is emitted but has no client dispatch branch
 * in `useSidecarStream.ts` — pre-existing, tracked separately.
 */

/** Push event method names. The client dispatcher routes by `method`. */
export const PushMethods = {
    Hello: "sidecar.hello",
    Attached: "session.attached",
    Detached: "session.detached",
    Event: "session.event",
    /** Tool call start; carries toolCallId / toolName / args. */
    ToolCallStart: "session.tool_call_start",
    /** Tool call partial update (e.g. bash streaming). */
    ToolCallUpdate: "session.tool_call_update",
    /** Tool call terminal state: isError + result. */
    ToolCallEnd: "session.tool_call_end",
    CommandPermissionRequested: "command_permission.requested",
    SubagentSpawned: "subagent.spawned",
    Error: "session.error",
    /**
     * Emitted when a compaction starts — automatic or via the `session.compact`
     * RPC; both share one code path. Desktop freezes its composer and shows a
     * "compacting" indicator for the duration.
     */
    CompactionStarted: "session.compaction_started",
    /**
     * Emitted when a compaction finishes, on success *and* failure, so a client
     * can always lift its freeze. Includes duration and post-compaction size.
     */
    CompactionFinished: "session.compaction_finished",
    /**
     * Tasks list change notification (emitted after any successful task
     * tool call). Desktop refreshes TaskPanel from this without scanning
     * the message stream.
     */
    TasksUpdated: "tasks.updated",
    /**
     * Plan-mode state change notification (emitted when planEnter /
     * planExit change state). Desktop drives PlanModeIndicator from
     * this rather than scanning message history.
     */
    PlanStateUpdated: "plan.state.updated",
    /**
     * Emitted after `settings.write` changes `apiKeys` or
     * `customProviders`. Desktop re-pulls `providers.list` /
     * `session.listModels` to refresh the Model menu and Provider
     * section without a restart. Workspace-dimensioned (no session).
     */
    ModelsChanged: "models.changed",
    /**
     * Emitted when a session is deleted via `session.delete`. Desktop
     * removes the session from its local list. Without this push, a
     * second client window or a post-recovery replay cannot learn about
     * deletions.
     */
    SessionDeleted: "session.deleted",
    /**
     * Emitted on every IM channel binding transition (QR shown, scanned,
     * connected, error, ...). Workspace-dimensioned (no session): binding is a
     * config-time operation with no conversation attached. Desktop drives the
     * Channels pane from this instead of polling.
     */
    ChannelStatusChanged: "channel.status_changed",
    /**
     * Invalidate notification: ConversationRouter created a new IM session
     * (or the underlying list shifted). Desktop re-pulls
     * `channels.listConversations`. Fires only on new-session creation —
     * not on every inbound message — so conversation volume cannot turn
     * this into a push-storm. Workspace-dimensioned (no session): a new
     * conversation has no attached session yet. Same invalidate-not-delta
     * pattern as TasksUpdated / PlanStateUpdated.
     */
    ConversationsChanged: "channels.conversations_changed",
    /**
     * Emitted once per IM workspace when local tools (shell / fs) are first
     * enabled for it. Workspace-dimensioned (no session): the notice targets
     * the chat itself, not a conversation turn. The WeChat adapter forwards
     * the text to the peer.
     */
    ImToolsEnabled: "im.tools_enabled",
    /**
     * Emitted after a successful `imPolicy.setChannelDefault` /
     * `imPolicy.setChatOverride` / `imPolicy.clearChatOverride` write.
     * Workspace-dimensioned (no session): policy writes don't attach to a
     * conversation, and the desktop editor needs to refresh on the same
     * tick. Same invalidate-not-delta pattern as ModelsChanged /
     * ConversationsChanged — payload carries only the channelId; the
     * desktop re-pulls `imPolicy.get` to repopulate the form.
     */
    ImPolicyChanged: "im.policy_changed",
    /**
     * Emitted by `invalidateImWorkspaces` immediately BEFORE a policy-change
     * disposes each IM workspace (interrupting any in-flight turn).
     * Workspace-dimensioned (no session): sent once per live workspace on the
     * channel. Unlike `im.policy_changed` this is not a refresh signal — it
     * warns that an in-progress conversation is being cut short. The WeChat
     * adapter broadcasts the interrupt notice to every routed peer.
     */
    ImWorkspacesInvalidated: "im.workspaces_invalidated",
} as const;

/**
 * `session.compaction_started` push params — emitted by the sidecar when a
 * compaction begins. Desktop marks the ContextIndicator "compacting" and
 * disables the composer (in ChatPane) for the duration.
 *
 * The client freeze is a UX affordance, not the safety mechanism: the sidecar
 * itself waits out an in-flight compaction before starting a turn and answers
 * `session_busy` if it never settles, so clients that ignore this frame are
 * still protected (the safety net is `session_busy` — see
 * `sessionTurn.ts:rethrowBusyAsSessionBusy`).
 */
export interface SessionCompactionStartedParams {
    cwd: WorkspaceId;
    sessionId: SessionId;
    /** Estimated tokens before compaction, same heuristic as `session.contextInfo.usedTokens`. */
    tokensBefore: number;
}

/**
 * `session.compaction_finished` push params — emitted on compaction finish
 * (success or failure; `failed=true` means the call threw). Desktop uses
 * this to lift the input freeze and show a toast.
 */
export interface SessionCompactionFinishedParams {
    cwd: WorkspaceId;
    sessionId: SessionId;
    tokensBefore: number;
    /** Summary character count from `CompactionEntry.summary.length`; 0 on failure. */
    summaryChars: number;
    /** Wall-clock duration in ms from `before_started` to `now` (server-side).
     *  Desktop surfaces "compaction took 9s" copy. */
    durationMs: number;
    /** True if a hook provided the summary (our pin-aware hook always does). */
    fromHook?: boolean;
    /**
     * True means the compaction committed no summary entry. That covers a throw
     * (summary call failed, harness busy) *and* the non-throwing cases — a hook
     * that cancelled, or a run that produced no entry. It is derived from the
     * absence of the entry, not from an exception.
     *
     * Emitted on both outcomes, so the client can lift its input freeze
     * unconditionally; only the toast copy branches on this field.
     */
    failed: boolean;
    /**
     * Machine-readable failure classification — the same enum the
     * `session.compact` RPC returns in `SessionCompactResult.reason`, so both
     * report a failure identically. Present iff `failed` is true. Branch on
     * this to pick localized copy.
     */
    reason?: CompactionFailureReason;
    /**
     * Free-text diagnostic detail, English only and not enumerated. Absent on
     * success, and absent for failures with nothing to add beyond `reason`.
     * Show it as supplementary text; never branch on it.
     */
    failureMessage?: string;
}

/**
 * tasks.updated push params — emitted by the sidecar after any successful task
 * tool call. Desktop uses this to refresh TaskPanel in real time.
 */
export interface TaskItem {
    id: string;
    content: string;
    /**
     * Task status. `failed` and `completed` are both terminal — neither
     * counts as active/incomplete. The difference: `failed` is excluded
     * from `completedCount` so the panel's "done" history doesn't
     * over-report.
     */
    status: "pending" | "in_progress" | "completed" | "failed";
    activeForm: string;
}

/** Metadata for one task list — used in the history list (no per-task detail). */
export interface TaskListMeta {
    id: string;
    name: string;
    taskCount: number;
    completedCount: number;
}

export interface TasksUpdatedParams {
    /**
     * The session that originated this push.
     * Workspace attribution is taken from the push frame's `workspace`
     * field; not duplicated here (avoids dual sources of truth).
     */
    sessionId: SessionId;
    /** Currently active list (with outstanding tasks); null means no active list. */
    active: {
        id: string;
        name: string;
        tasks: TaskItem[];
    } | null;
    /** Metadata for completed lists (history archive), newest first. */
    history: TaskListMeta[];
}

/**
 * `plan.state.updated` push params — emitted when planEnter / planExit
 * change state. Desktop's PlanModeIndicator subscribes to this directly
 * instead of scanning message history.
 */
export interface PlanStateUpdatedParams {
    sessionId: SessionId;
    active: boolean;
    currentSlug: string | null;
}

/** `session.tool_call_start` params. */
export interface ToolCallStartParams {
    ts: number;
    /** Stable correlation id — `AssistantMessage.content[].id === ToolResultMessage.toolCallId`. */
    toolCallId: string;
    toolName: string;
    args?: unknown;
}

/** `session.tool_call_update` params. */
export interface ToolCallUpdateParams {
    ts: number;
    toolCallId: string;
    /** Streaming partial result. */
    partialResult?: unknown;
}

/** `session.tool_call_end` params. */
export interface ToolCallEndParams {
    ts: number;
    toolCallId: string;
    /** Tool name from the harness — included on `_end` so the desktop can
     *  render the final row even if the matching `_start` was missed (e.g.
     *  client restarted mid-tool). `_start` already carries it; `_end`
     *  repeats it for the same reason. */
    toolName?: string;
    isError: boolean;
    /** Terminal result (content shape from harness). */
    result?: {
        content?: Array<{ type?: string; text?: string }>;
        details?: unknown;
    };
}

/** `session.attached` params — emitted when a session becomes attached.
 *  Empty by design; the desktop already knows the (workspace, sessionId)
 *  pair from the push frame and pulls state via `session.snapshot.get`. */
export type AttachedParams = Record<string, never>;

/** `session.detached` params — emitted when a session is detached (e.g.
 *  workspace dispose). Empty for the same reason as AttachedParams. */
export type DetachedParams = Record<string, never>;

/** `session.event` params — generic envelope for AgentHarnessEvent
 *  variants that don't get their own typed push (non-tool events,
 *  message deltas, lifecycle signals). The desktop router dispatches
 *  on `event.type`. */
export interface EventParams {
    event: unknown;
}

/** `command_permission.requested` params — runtime emits the request as-is
 *  after `redactCommandPermissionRequest` scrubs the command string for
 *  secret-shaped literals (API keys, bearer tokens). Shape mirrors the
 *  internal permission request schema. */
export interface CommandPermissionRequestedParams {
    [extension: string]: unknown;
}

/** `subagent.spawned` params — runtime emits when a parent session spawns
 *  a sub-session via the `agent` tool. The desktop renders a breadcrumb
 *  linking back to the parent turn. */
export interface SubagentSpawnedParams {
    parentSessionId: SessionId;
    parentToolCallId: string;
    subSessionId: SessionId;
    agentType: string;
}

/** `session.error` params — terminal error frame for a session; the
 *  desktop surfaces a toast and freezes input until the user retries. */
export interface ErrorParams {
    error: string;
}

/** `models.changed` params — invalidate signal after `settings.write`
 *  changes `apiKeys` or `customProviders`. Empty; desktop re-pulls
 *  `providers.list` / `session.listModels` to refresh the menu. */
export type ModelsChangedParams = Record<string, never>;

/** `session.deleted` params — emitted by `session.delete` and as the
 *  terminal sequenced event in the event-log stream. Empty; the push
 *  frame already carries workspace + sessionId. */
export type SessionDeletedParams = Record<string, never>;

/** `channels.conversations_changed` params — invalidate signal when
 *  ConversationRouter created a new IM session. Empty; desktop re-pulls
 *  `channels.listConversations`. */
export type ConversationsChangedParams = Record<string, never>;

/** `im.tools_enabled` push params — the notice text a channel should forward. */
export interface ImToolsEnabledParams {
    text: string;
}

/** `im.policy_changed` push params — invalidate signal; desktop re-pulls `imPolicy.get`. */
export interface ImPolicyChangedParams {
    channelId: string;
}

/**
 * `im.workspaces_invalidated` push params — pre-dispose notice for a
 * policy-change that is about to interrupt live conversations. Sent once per
 * IM workspace on the channel; the desktop may warn the operator and the
 * channel adapter may broadcast to peers.
 */
export interface ImWorkspacesInvalidatedParams {
    channelId: string;
    /** Present when at least one live conversation on this channel is being interrupted. */
    interruptedCount?: number;
}

/**
 * Per-method params map — single source of truth for the push wire contract.
 * `emitPush(method, ...)` uses `PushParams<typeof method>` to type its
 * `params` argument, so a stray field name or a missing required field
 * surfaces as a typecheck error at the call site.
 */
export interface PushParamsByMethod {
    [PushMethods.Hello]: SidecarHelloParams;
    [PushMethods.Attached]: AttachedParams;
    [PushMethods.Detached]: DetachedParams;
    [PushMethods.Event]: EventParams;
    [PushMethods.ToolCallStart]: ToolCallStartParams;
    [PushMethods.ToolCallUpdate]: ToolCallUpdateParams;
    [PushMethods.ToolCallEnd]: ToolCallEndParams;
    [PushMethods.CommandPermissionRequested]: CommandPermissionRequestedParams;
    [PushMethods.SubagentSpawned]: SubagentSpawnedParams;
    [PushMethods.Error]: ErrorParams;
    [PushMethods.CompactionStarted]: SessionCompactionStartedParams;
    [PushMethods.CompactionFinished]: SessionCompactionFinishedParams;
    [PushMethods.TasksUpdated]: TasksUpdatedParams;
    [PushMethods.PlanStateUpdated]: PlanStateUpdatedParams;
    [PushMethods.ModelsChanged]: ModelsChangedParams;
    [PushMethods.SessionDeleted]: SessionDeletedParams;
    [PushMethods.ChannelStatusChanged]: ChannelStatusChangedParams;
    [PushMethods.ConversationsChanged]: ConversationsChangedParams;
    [PushMethods.ImToolsEnabled]: ImToolsEnabledParams;
    [PushMethods.ImPolicyChanged]: ImPolicyChangedParams;
    [PushMethods.ImWorkspacesInvalidated]: ImWorkspacesInvalidatedParams;
}

export type PushMethodName = (typeof PushMethods)[keyof typeof PushMethods];

export type PushParams<M extends PushMethodName> = PushParamsByMethod[M];
