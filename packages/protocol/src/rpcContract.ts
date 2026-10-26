/**
 * RPC contract table — the single source of truth for every method the
 * sidecar registers.
 *
 * Each row names one wire method and pins four things together:
 *
 *   - `method`  the wire name (`"session.prompt"`), the value the client sends.
 *   - `params`  the TypeScript type of the `params` object on the wire.
 *   - `result`  the TypeScript type of the value the handler returns.
 *   - `scope`   how the client routes the call: `workspace` (needs a routing
 *               key) or `process` (no workspace dimension).
 *
 * The handler's `params` type and its return type are checked against this
 * table at compile time, so a drifted interface fails the build instead of
 * surfacing as a runtime error. The client side reads the same table, so a
 * method name or result shape cannot differ between the two halves.
 *
 * `scope` is the *client routing* dimension. It is deliberately separate from
 * the server's `ensureWorkspace` flag: `workspace.ensure` and
 * `workspace.dispose` are routed by workspace but need no workspace runtime
 * on the server, so the two axes disagree for three methods.
 *
 * Result types that the client never reads as a structured payload are
 * declared as `void` — the wire still carries a value, but no caller depends
 * on its shape, so pinning one would be a false promise.
 */

import type { Static } from "typebox";
import type {
    ChannelsBindParams,
    ChannelsBindResult,
    ChannelsCreateParams,
    ChannelsCreateResult,
    ChannelsListConversationsParams,
    ChannelsListConversationsResult,
    ChannelsListParams,
    ChannelsListResult,
    ChannelsRetryParams,
    ChannelsRetryResult,
    ChannelsSubmitVerifyCodeParams,
    ChannelsSubmitVerifyCodeResult,
    ChannelsUnbindParams,
    ChannelsUnbindResult,
} from "./channels.js";
import type {
    CheckpointsListParams,
    CheckpointsListResult,
    CheckpointsRestoreParams,
    CheckpointsRestoreResult,
} from "./checkpoints.js";
import type {
    CommandPermissionResolveParams,
    CommandPermissionResolveResult,
    ConfigPatchParams,
    ConfigPatchResult,
    ExtensionsStatusParams,
    ExtensionsStatusResult,
    McpCreateConfigParams,
    McpDeleteConfigParams,
    McpDeleteConfigResult,
    McpGetConfigParams,
    McpGetConfigResult,
    McpListServersParams,
    McpListServersResult,
    McpMutateConfigResult,
    McpUpdateConfigParams,
    SettingsGetParams,
    SettingsGetResult,
    SettingsWriteParams,
    SettingsWriteResult,
} from "./config.js";
import type { InitializeParams, InitializeResult, SessionId, WorkspaceId } from "./frames.js";
import type {
    ImPolicyClearChatOverrideParams,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImPolicySetChannelDefaultParams,
    ImPolicySetChatOverrideParams,
    ImPolicyWriteResult,
} from "./imPolicy.js";
import type {
    JobRunResult,
    JobsCreateParams,
    JobsDeleteResult,
    JobsGetResult,
    JobsHistoryResult,
    JobsIdParams,
    JobsListParams,
    JobsListResult,
    JobsUpdateParams,
    JobsWriteResult,
} from "./jobs.js";
import type {
    MemoryDeleteTopicParams,
    MemoryDeleteTopicResult,
    MemoryDreamApplyParams,
    MemoryDreamApplyResult,
    MemoryDreamDiscardParams,
    MemoryDreamDiscardResult,
    MemoryDreamRunParams,
    MemoryDreamRunResult,
    MemoryDreamUndoParams,
    MemoryDreamUndoResult,
    MemoryListParams,
    MemoryListResult,
    MemoryRestoreTopicParams,
    MemoryRestoreTopicResult,
    MemoryUpsertParams,
    MemoryUpsertResult,
    MemoryWriteParams,
    MemoryWriteResult,
} from "./memory.js";
import type { PlanStateUpdatedParams, TaskItem, TasksUpdatedParams } from "./push.js";
import {
    agentsContentSchema,
    agentsDeleteSchema,
    agentsListSchema,
    agentsWriteSchema,
    channelsBindSchema,
    channelsCreateSchema,
    channelsListConversationsSchema,
    channelsListSchema,
    channelsRetrySchema,
    channelsSubmitVerifyCodeSchema,
    channelsUnbindSchema,
    checkpointsListSchema,
    checkpointsRestoreSchema,
    commandPermissionResolveSchema,
    configPatchSchema,
    extensionsStatusSchema,
    imPolicyClearChatOverrideSchema,
    imPolicyGetSchema,
    imPolicySetChannelDefaultSchema,
    imPolicySetChatOverrideSchema,
    initializeSchema,
    jobsCreateSchema,
    jobsDeleteSchema,
    jobsGetSchema,
    jobsHistorySchema,
    jobsListSchema,
    jobsRunNowSchema,
    jobsUpdateSchema,
    mcpCreateConfigSchema,
    mcpDeleteConfigSchema,
    mcpGetConfigSchema,
    mcpListServersSchema,
    mcpUpdateConfigSchema,
    memoryDeleteTopicSchema,
    memoryDreamApplySchema,
    memoryDreamDiscardSchema,
    memoryDreamRunSchema,
    memoryDreamUndoSchema,
    memoryListSchema,
    memoryRestoreTopicSchema,
    memoryUpsertSchema,
    memoryWriteSchema,
    providerListModelsSchema,
    providersListSchema,
    providersRevealKeySchema,
    providerTestConnectionSchema,
    sessionAbortSchema,
    sessionAttachSchema,
    sessionCancelQueuedSchema,
    sessionCompactSchema,
    sessionContextInfoSchema,
    sessionCreateSchema,
    sessionDeleteSchema,
    sessionDetachSchema,
    sessionEventsGetSchema,
    sessionFollowUpSchema,
    sessionHistorySchema,
    sessionListModelsSchema,
    sessionListSchema,
    sessionPlanStateGetSchema,
    sessionPromptSchema,
    sessionRenameSchema,
    sessionSetModelSchema,
    sessionSetThinkingLevelSchema,
    sessionSnapshotGetSchema,
    sessionSteerSchema,
    sessionSubmitAnswersSchema,
    sessionTaskHistoryGetSchema,
    sessionTasksGetSchema,
    settingsGetSchema,
    settingsWriteSchema,
    skillContentSchema,
    skillsListSchema,
    subagentAbortSchema,
    toolsListSchema,
    workspaceAssociationsGetSchema,
    workspaceAssociationsResolveSchema,
    workspaceAssociationsSetSchema,
    workspaceDisposeSchema,
    workspaceEnsureSchema,
    workspaceListSchema,
} from "./schemas/index.js";
import type {
    AbortParams,
    AbortResult,
    CancelQueuedParams,
    CancelQueuedResult,
    CreateSessionParams,
    CreateSessionResult,
    DeleteSessionParams,
    FollowUpParams,
    FollowUpResult,
    ListModelsParams,
    PromptParams,
    PromptResult,
    ProviderListModelsParams,
    ProviderListModelsResult,
    ProvidersListParams,
    ProvidersListResult,
    ProvidersRevealKeyParams,
    ProvidersRevealKeyResult,
    ProviderTestConnectionParams,
    ProviderTestConnectionResult,
    RenameSessionParams,
    SessionAttachParams,
    SessionCompactParams,
    SessionCompactResult,
    SessionContextInfoParams,
    SessionContextInfoResult,
    SessionDetachParams,
    SessionEventsGetParams,
    SessionEventsGetResult,
    SessionHistory,
    SessionHistoryParams,
    SessionListParams,
    SessionListResult,
    SessionPlanStateGetParams,
    SessionSetThinkingLevelParams,
    SessionSnapshot,
    SessionSnapshotGetParams,
    SessionTaskHistoryGetParams,
    SessionTasksGetParams,
    SetModelParams,
    SteerParams,
    SteerResult,
    SubagentAbortParams,
    SubagentAbortResult,
} from "./session.js";
import type {
    AgentsContentParams,
    AgentsContentResult,
    AgentsDeleteParams,
    AgentsDeleteResult,
    AgentsListParams,
    AgentsListResult,
    AgentsWriteParams,
    AgentsWriteResult,
    SkillContentParams,
    SkillContentResult,
    SkillsListParams,
    SkillsListResult,
    SubmitAnswersParams,
    ToolsListParams,
    ToolsListResult,
} from "./tools.js";
import type {
    WorkspaceAssociationsGetParams,
    WorkspaceAssociationsGetResult,
    WorkspaceAssociationsResolveParams,
    WorkspaceAssociationsResolveResult,
    WorkspaceAssociationsSetParams,
    WorkspaceAssociationsSetResult,
} from "./workspace.js";

/**
 * How the client routes a call.
 *
 * `workspace` — the transport picks a per-workspace sidecar; the call carries
 * a workspace key in its routing position.
 * `process` — the transport picks a process-level sidecar; no workspace
 * dimension travels with the call.
 */
export type RpcScope = "workspace" | "process";

/**
 * Result shapes the client reads but that have no named protocol type.
 *
 * These live in `typedRpc.ts` today as inline literals. Moving them here
 * makes the table the only place a wire result shape is written down.
 */

/** `session.attach` result — the attach acknowledgement plus live subagent state. */
export interface SessionAttachResult {
    attached: true;
    sessionId: SessionId;
    /**
     * parentToolCallIds whose subagent is running in the sidecar right now.
     * Absent on older sidecars. Process-memory state, so a fresh process
     * reports none — which is what lets a client expire agent tool cards
     * orphaned by a previous process exit without touching live ones.
     */
    inFlightAgentToolCallIds?: string[];
    /**
     * Child session ids under this parent that already produced a result
     * file. Unlike the list above this is read from disk, so it survives the
     * process that ran them — which is what separates a background child
     * that finished from one a previous process was killed mid-run. Absent
     * on older sidecars.
     */
    settledBackgroundSubSessionIds?: string[];
}

/** `session.detach` result. */
export interface SessionDetachResult {
    detached: true;
}

/** `session.delete` result. */
export interface SessionDeleteResult {
    deleted: true;
}

/** `session.rename` result. */
export interface SessionRenameResult {
    renamed: true;
}

/** `session.setModel` result. */
export interface SessionSetModelResult {
    switchedTo: { provider: string; modelId: string };
}

/** `session.setThinkingLevel` result. */
export interface SessionSetThinkingLevelResult {
    level: SessionSetThinkingLevelParams["level"];
}

/** `session.listModels` result. */
export interface SessionListModelsResult {
    models: Array<{ provider: string; id: string; name?: string }>;
}

/** `session.taskHistory.get` result — the expanded item list for one history list. */
export type SessionTaskHistoryGetResult = TaskItem[];

/** `session.tasks.get` result — the current task list snapshot. */
export type SessionTasksGetResult = Pick<TasksUpdatedParams, "active" | "history">;

/** `session.planState.get` result — the current plan-mode state. */
export type SessionPlanStateGetResult = Pick<PlanStateUpdatedParams, "active" | "currentSlug">;

/** `workspace.list` result — the known workspace keys. */
export type WorkspaceListResult = WorkspaceId[];

/** `workspace.ensure` result — echoes the ensured workspace key. */
export interface WorkspaceEnsureResult {
    cwd: WorkspaceId;
}

/** `workspace.dispose` result — nothing; the workspace is gone. */
export type WorkspaceDisposeResult = null;

/**
 * The contract table, keyed by camelCase constant name.
 *
 * The key is the name used in `RPC.<key>` on the client and
 * `registerMethod(RPC.<key>, …)` on the server. `method` is the wire name.
 * Keeping both in one row is what lets the client and the server share a
 * single source of truth without a second table to keep in sync.
 */
export const RPC = {
    // Process-level bootstrap. First client → server request on a connection.
    initialize: "initialize",
    // workspace.*
    workspaceList: "workspace.list",
    workspaceEnsure: "workspace.ensure",
    workspaceDispose: "workspace.dispose",
    /** Read the associated-directory set stored at one key (workspace or channel scope). */
    workspaceAssociationsGet: "workspace.associations.get",
    /** Replace the associated-directory set stored at one key. */
    workspaceAssociationsSet: "workspace.associations.set",
    /** The effective associated-directory set for a workspace, after the scope fallback. */
    workspaceAssociationsResolve: "workspace.associations.resolve",
    // session.*
    sessionList: "session.list",
    sessionCreate: "session.create",
    sessionAttach: "session.attach",
    sessionDetach: "session.detach",
    sessionDelete: "session.delete",
    sessionRename: "session.rename",
    sessionHistory: "session.history",
    sessionEventsGet: "session.events.get",
    sessionSnapshotGet: "session.snapshot.get",
    sessionTasksGet: "session.tasks.get",
    /** Fetch the full task list for a given history list (history pushes meta only; expand on demand). */
    sessionTaskHistoryGet: "session.taskHistory.get",
    sessionPlanStateGet: "session.planState.get",
    sessionPrompt: "session.prompt",
    sessionSteer: "session.steer",
    /** Like steer, but consumed only at may-finish boundaries. */
    sessionFollowUp: "session.followUp",
    /** Remove one not-yet-consumed queue entry (steer/followUp/nextRun). */
    sessionCancelQueued: "session.cancelQueued",
    sessionAbort: "session.abort",
    /** Stop one running subagent (by child session id) without aborting the parent's turn. */
    subagentAbort: "subagent.abort",
    commandPermissionResolve: "commandPermission.resolve",
    sessionSetModel: "session.setModel",
    sessionListModels: "session.listModels",
    /** List the availability view of built-in providers (configured + models) for the Model settings UI. */
    providersList: "providers.list",
    /** Return one provider's plaintext API key (settings UI "reveal" toggle). */
    providersRevealKey: "providers.revealKey",
    sessionSetThinkingLevel: "session.setThinkingLevel",
    sessionCompact: "session.compact",
    sessionContextInfo: "session.contextInfo",
    /** Submit askUser answers — sidecar injects <ask_user_context> into the user message; clients don't see the wire format. */
    sessionSubmitAnswers: "session.submitAnswers",
    /** Pull model ids from a provider's /models endpoint for the settings model list. */
    providerListModels: "provider.listModels",
    /** Send one minimal chat turn to verify key + endpoint + protocol + model id. */
    providerTestConnection: "provider.testConnection",
    // settings.*
    settingsGet: "settings.get",
    settingsWrite: "settings.write",
    // config.* — the model's view of the global config. `config.patch` asks
    // the user before writing; `settings.write` is the desktop's own path
    // and needs no approval.
    configPatch: "config.patch",
    // extensions.*
    extensionsStatus: "extensions.status",
    // channels.* — IM channel listing / binding.
    channelsList: "channels.list",
    channelsListConversations: "channels.listConversations",
    channelsCreate: "channels.create",
    channelsBind: "channels.bind",
    channelsSubmitVerifyCode: "channels.submitVerifyCode",
    channelsUnbind: "channels.unbind",
    channelsRetry: "channels.retry",
    // imPolicy.* — IM workspace policy admin (process-level).
    imPolicyGet: "imPolicy.get",
    imPolicySetChannelDefault: "imPolicy.setChannelDefault",
    imPolicySetChatOverride: "imPolicy.setChatOverride",
    imPolicyClearChatOverride: "imPolicy.clearChatOverride",
    // tools.*
    toolsList: "tools.list",
    // agents.*
    agentsList: "agents.list",
    agentsContent: "agents.content",
    agentsWrite: "agents.write",
    agentsDelete: "agents.delete",
    skillsList: "skills.list",
    skillContent: "skills.content",
    // checkpoints.* — pre-write file snapshots; restore is client-driven only.
    checkpointsList: "checkpoints.list",
    checkpointsRestore: "checkpoints.restore",
    // memory.*
    memoryList: "memory.list",
    memoryWrite: "memory.write",
    memoryDeleteTopic: "memory.deleteTopic",
    memoryUpsert: "memory.upsert",
    memoryRestoreTopic: "memory.restoreTopic",
    // memory.dream* — consolidation preview / apply / discard / undo.
    memoryDreamRun: "memory.dreamRun",
    memoryDreamApply: "memory.dreamApply",
    memoryDreamDiscard: "memory.dreamDiscard",
    memoryDreamUndo: "memory.dreamUndo",
    // mcp.* — MCP server discovery and health status.
    mcpListServers: "mcp.listServers",
    mcpGetConfig: "mcp.getConfig",
    mcpCreateConfig: "mcp.createConfig",
    mcpUpdateConfig: "mcp.updateConfig",
    mcpDeleteConfig: "mcp.deleteConfig",
    // ── jobs.* ──
    jobsList: "jobs.list",
    jobsGet: "jobs.get",
    jobsCreate: "jobs.create",
    jobsUpdate: "jobs.update",
    jobsDelete: "jobs.delete",
    jobsRunNow: "jobs.runNow",
    jobsHistory: "jobs.history",
} as const;

export const rpcContract = {
    initialize: { scope: "process" } as RpcContractRow<InitializeParams, InitializeResult>,
    workspaceList: { scope: "process" } as RpcContractRow<void, WorkspaceListResult>,
    workspaceEnsure: { scope: "workspace" } as RpcContractRow<
        { cwd: WorkspaceId },
        WorkspaceEnsureResult
    >,
    workspaceDispose: { scope: "workspace" } as RpcContractRow<
        { cwd: WorkspaceId },
        WorkspaceDisposeResult
    >,
    workspaceAssociationsGet: { scope: "process" } as RpcContractRow<
        WorkspaceAssociationsGetParams,
        WorkspaceAssociationsGetResult
    >,
    workspaceAssociationsSet: { scope: "process" } as RpcContractRow<
        WorkspaceAssociationsSetParams,
        WorkspaceAssociationsSetResult
    >,
    workspaceAssociationsResolve: { scope: "workspace" } as RpcContractRow<
        WorkspaceAssociationsResolveParams,
        WorkspaceAssociationsResolveResult
    >,
    sessionList: { scope: "workspace" } as RpcContractRow<SessionListParams, SessionListResult>,
    sessionCreate: { scope: "workspace" } as RpcContractRow<
        CreateSessionParams,
        CreateSessionResult
    >,
    sessionAttach: { scope: "workspace" } as RpcContractRow<
        SessionAttachParams,
        SessionAttachResult
    >,
    sessionDetach: { scope: "workspace" } as RpcContractRow<
        SessionDetachParams,
        SessionDetachResult
    >,
    sessionDelete: { scope: "workspace" } as RpcContractRow<
        DeleteSessionParams,
        SessionDeleteResult
    >,
    sessionRename: { scope: "workspace" } as RpcContractRow<
        RenameSessionParams,
        SessionRenameResult
    >,
    sessionHistory: { scope: "workspace" } as RpcContractRow<SessionHistoryParams, SessionHistory>,
    sessionEventsGet: { scope: "workspace" } as RpcContractRow<
        SessionEventsGetParams,
        SessionEventsGetResult
    >,
    sessionSnapshotGet: { scope: "workspace" } as RpcContractRow<
        SessionSnapshotGetParams,
        SessionSnapshot
    >,
    sessionTasksGet: { scope: "workspace" } as RpcContractRow<
        SessionTasksGetParams,
        SessionTasksGetResult
    >,
    sessionTaskHistoryGet: { scope: "workspace" } as RpcContractRow<
        SessionTaskHistoryGetParams,
        SessionTaskHistoryGetResult
    >,
    sessionPlanStateGet: { scope: "workspace" } as RpcContractRow<
        SessionPlanStateGetParams,
        SessionPlanStateGetResult
    >,
    sessionPrompt: { scope: "workspace" } as RpcContractRow<PromptParams, PromptResult>,
    sessionSteer: { scope: "workspace" } as RpcContractRow<SteerParams, SteerResult>,
    sessionFollowUp: { scope: "workspace" } as RpcContractRow<FollowUpParams, FollowUpResult>,
    sessionCancelQueued: { scope: "workspace" } as RpcContractRow<
        CancelQueuedParams,
        CancelQueuedResult
    >,
    sessionSubmitAnswers: { scope: "workspace" } as RpcContractRow<SubmitAnswersParams, null>,
    sessionAbort: { scope: "workspace" } as RpcContractRow<AbortParams, AbortResult>,
    subagentAbort: { scope: "workspace" } as RpcContractRow<
        SubagentAbortParams,
        SubagentAbortResult
    >,
    sessionSetModel: { scope: "workspace" } as RpcContractRow<
        SetModelParams,
        SessionSetModelResult
    >,
    sessionSetThinkingLevel: { scope: "workspace" } as RpcContractRow<
        SessionSetThinkingLevelParams,
        SessionSetThinkingLevelResult
    >,
    sessionListModels: { scope: "workspace" } as RpcContractRow<
        ListModelsParams,
        SessionListModelsResult
    >,
    sessionCompact: { scope: "workspace" } as RpcContractRow<
        SessionCompactParams,
        SessionCompactResult
    >,
    sessionContextInfo: { scope: "workspace" } as RpcContractRow<
        SessionContextInfoParams,
        SessionContextInfoResult
    >,
    providersList: { scope: "workspace" } as RpcContractRow<
        ProvidersListParams,
        ProvidersListResult
    >,
    providersRevealKey: { scope: "workspace" } as RpcContractRow<
        ProvidersRevealKeyParams,
        ProvidersRevealKeyResult
    >,
    providerListModels: { scope: "process" } as RpcContractRow<
        ProviderListModelsParams,
        ProviderListModelsResult
    >,
    providerTestConnection: { scope: "process" } as RpcContractRow<
        ProviderTestConnectionParams,
        ProviderTestConnectionResult
    >,
    settingsGet: { scope: "process" } as RpcContractRow<SettingsGetParams, SettingsGetResult>,
    settingsWrite: { scope: "process" } as RpcContractRow<SettingsWriteParams, SettingsWriteResult>,
    configPatch: { scope: "workspace" } as RpcContractRow<ConfigPatchParams, ConfigPatchResult>,
    extensionsStatus: { scope: "process" } as RpcContractRow<
        ExtensionsStatusParams,
        ExtensionsStatusResult
    >,
    channelsList: { scope: "process" } as RpcContractRow<ChannelsListParams, ChannelsListResult>,
    channelsListConversations: { scope: "process" } as RpcContractRow<
        ChannelsListConversationsParams,
        ChannelsListConversationsResult
    >,
    channelsCreate: { scope: "process" } as RpcContractRow<
        ChannelsCreateParams,
        ChannelsCreateResult
    >,
    channelsBind: { scope: "process" } as RpcContractRow<ChannelsBindParams, ChannelsBindResult>,
    channelsSubmitVerifyCode: { scope: "process" } as RpcContractRow<
        ChannelsSubmitVerifyCodeParams,
        ChannelsSubmitVerifyCodeResult
    >,
    channelsUnbind: { scope: "process" } as RpcContractRow<
        ChannelsUnbindParams,
        ChannelsUnbindResult
    >,
    channelsRetry: { scope: "process" } as RpcContractRow<ChannelsRetryParams, ChannelsRetryResult>,
    imPolicyGet: { scope: "process" } as RpcContractRow<ImPolicyGetParams, ImPolicyGetResult>,
    imPolicySetChannelDefault: { scope: "process" } as RpcContractRow<
        ImPolicySetChannelDefaultParams,
        ImPolicyWriteResult
    >,
    imPolicySetChatOverride: { scope: "process" } as RpcContractRow<
        ImPolicySetChatOverrideParams,
        ImPolicyWriteResult
    >,
    imPolicyClearChatOverride: { scope: "process" } as RpcContractRow<
        ImPolicyClearChatOverrideParams,
        ImPolicyWriteResult
    >,
    commandPermissionResolve: { scope: "workspace" } as RpcContractRow<
        CommandPermissionResolveParams,
        CommandPermissionResolveResult
    >,
    toolsList: { scope: "workspace" } as RpcContractRow<ToolsListParams, ToolsListResult>,
    agentsList: { scope: "workspace" } as RpcContractRow<AgentsListParams, AgentsListResult>,
    agentsContent: { scope: "workspace" } as RpcContractRow<
        AgentsContentParams,
        AgentsContentResult
    >,
    agentsWrite: { scope: "workspace" } as RpcContractRow<AgentsWriteParams, AgentsWriteResult>,
    agentsDelete: { scope: "workspace" } as RpcContractRow<AgentsDeleteParams, AgentsDeleteResult>,
    skillsList: { scope: "workspace" } as RpcContractRow<SkillsListParams, SkillsListResult>,
    skillContent: { scope: "workspace" } as RpcContractRow<SkillContentParams, SkillContentResult>,
    checkpointsList: { scope: "workspace" } as RpcContractRow<
        CheckpointsListParams,
        CheckpointsListResult
    >,
    checkpointsRestore: { scope: "workspace" } as RpcContractRow<
        CheckpointsRestoreParams,
        CheckpointsRestoreResult
    >,
    memoryList: { scope: "workspace" } as RpcContractRow<MemoryListParams, MemoryListResult>,
    memoryWrite: { scope: "workspace" } as RpcContractRow<MemoryWriteParams, MemoryWriteResult>,
    memoryDeleteTopic: { scope: "workspace" } as RpcContractRow<
        MemoryDeleteTopicParams,
        MemoryDeleteTopicResult
    >,
    memoryRestoreTopic: { scope: "workspace" } as RpcContractRow<
        MemoryRestoreTopicParams,
        MemoryRestoreTopicResult
    >,
    memoryUpsert: { scope: "workspace" } as RpcContractRow<MemoryUpsertParams, MemoryUpsertResult>,
    memoryDreamRun: { scope: "workspace" } as RpcContractRow<
        MemoryDreamRunParams,
        MemoryDreamRunResult
    >,
    memoryDreamApply: { scope: "workspace" } as RpcContractRow<
        MemoryDreamApplyParams,
        MemoryDreamApplyResult
    >,
    memoryDreamDiscard: { scope: "workspace" } as RpcContractRow<
        MemoryDreamDiscardParams,
        MemoryDreamDiscardResult
    >,
    memoryDreamUndo: { scope: "workspace" } as RpcContractRow<
        MemoryDreamUndoParams,
        MemoryDreamUndoResult
    >,
    mcpListServers: { scope: "process" } as RpcContractRow<
        McpListServersParams,
        McpListServersResult
    >,
    mcpGetConfig: { scope: "process" } as RpcContractRow<McpGetConfigParams, McpGetConfigResult>,
    mcpCreateConfig: { scope: "process" } as RpcContractRow<
        McpCreateConfigParams,
        McpMutateConfigResult
    >,
    mcpUpdateConfig: { scope: "process" } as RpcContractRow<
        McpUpdateConfigParams,
        McpMutateConfigResult
    >,
    mcpDeleteConfig: { scope: "process" } as RpcContractRow<
        McpDeleteConfigParams,
        McpDeleteConfigResult
    >,
    // ── jobs.* ──
    jobsList: { scope: "process" } as RpcContractRow<JobsListParams, JobsListResult>,
    jobsGet: { scope: "process" } as RpcContractRow<JobsIdParams, JobsGetResult>,
    jobsCreate: { scope: "process" } as RpcContractRow<JobsCreateParams, JobsWriteResult>,
    jobsUpdate: { scope: "process" } as RpcContractRow<JobsUpdateParams, JobsWriteResult>,
    jobsDelete: { scope: "process" } as RpcContractRow<JobsIdParams, JobsDeleteResult>,
    jobsRunNow: { scope: "process" } as RpcContractRow<JobsIdParams, JobRunResult>,
    jobsHistory: { scope: "process" } as RpcContractRow<JobsIdParams, JobsHistoryResult>,
};

/**
 * One row of the type contract: the wire types of a method.
 *
 * `scope` is the *client routing* dimension — whether the call carries a
 * workspace key. It is deliberately separate from the server's
 * `ensureWorkspace` flag: `workspace.ensure` and `workspace.dispose` are
 * routed by workspace but need no workspace runtime on the server, so the
 * two axes disagree for three methods.
 */
export interface RpcContractRow<P, R> {
    readonly scope: RpcScope;
    /** Phantom carrier for the wire params type — never present at runtime. */
    readonly __params?: P;
    /** Phantom carrier for the wire result type — never present at runtime. */
    readonly __result?: R;
}

/** Every camelCase contract key. */
export type RpcContractKey = keyof typeof rpcContract;

/** Every wire method name the sidecar serves. */
export type RpcMethodName = (typeof RPC)[RpcContractKey];

/**
 * The wire params type of one contract key.
 *
 * `RpcContractRow` carries the types as optional phantom fields, so the
 * inferred type is `P | undefined`; `NonNullable` removes that. It must not
 * be applied to the *result* type — a method may legitimately return `null`.
 */
export type RpcParams<K extends RpcContractKey> = NonNullable<
    (typeof rpcContract)[K] extends RpcContractRow<infer P, unknown> ? P : never
>;

/** The wire result type of one contract key. */
export type RpcResult<K extends RpcContractKey> =
    (typeof rpcContract)[K] extends RpcContractRow<unknown, infer R> ? R : never;

/** The client routing scope of one contract key. */
export type RpcScopeOf<K extends RpcContractKey> = (typeof rpcContract)[K]["scope"];

/**
 * The two tables must list exactly the same methods.
 *
 * `RPC` holds the wire names and `rpcContract` holds the types. Keeping
 * them apart is what lets the method name be written once while the types
 * stay in a type-only structure — but the pairing must not drift, so
 * `contractKeysMatchRpcKeys` (below) fails the build if either side gains or
 * loses a method.
 */

/** Every contract key whose scope is `workspace` — routed with a workspace key. */
export type WorkspaceScopedKey = {
    [K in RpcContractKey]: RpcScopeOf<K> extends "workspace" ? K : never;
}[RpcContractKey];

/** Every contract key whose scope is `process` — routed without a workspace key. */
export type ProcessScopedKey = {
    [K in RpcContractKey]: RpcScopeOf<K> extends "process" ? K : never;
}[RpcContractKey];

/**
 * The params schema for every method.
 *
 * The value types are deliberately NOT widened to `TSchema`: a bare
 * `TSchema` is an empty interface, so `Static<>` of it yields nothing and
 * the schema/params binding below would silently check nothing. Keeping each
 * schema's own type is what makes that assertion meaningful.
 */
export const rpcSchemas = {
    initialize: initializeSchema,
    workspaceList: workspaceListSchema,
    workspaceEnsure: workspaceEnsureSchema,
    workspaceDispose: workspaceDisposeSchema,
    workspaceAssociationsGet: workspaceAssociationsGetSchema,
    workspaceAssociationsSet: workspaceAssociationsSetSchema,
    workspaceAssociationsResolve: workspaceAssociationsResolveSchema,
    sessionList: sessionListSchema,
    sessionCreate: sessionCreateSchema,
    sessionAttach: sessionAttachSchema,
    sessionDetach: sessionDetachSchema,
    sessionDelete: sessionDeleteSchema,
    sessionRename: sessionRenameSchema,
    sessionHistory: sessionHistorySchema,
    sessionEventsGet: sessionEventsGetSchema,
    sessionSnapshotGet: sessionSnapshotGetSchema,
    sessionTasksGet: sessionTasksGetSchema,
    sessionTaskHistoryGet: sessionTaskHistoryGetSchema,
    sessionPlanStateGet: sessionPlanStateGetSchema,
    sessionPrompt: sessionPromptSchema,
    sessionSteer: sessionSteerSchema,
    sessionFollowUp: sessionFollowUpSchema,
    sessionCancelQueued: sessionCancelQueuedSchema,
    sessionSubmitAnswers: sessionSubmitAnswersSchema,
    sessionAbort: sessionAbortSchema,
    subagentAbort: subagentAbortSchema,
    sessionSetModel: sessionSetModelSchema,
    sessionSetThinkingLevel: sessionSetThinkingLevelSchema,
    sessionListModels: sessionListModelsSchema,
    sessionCompact: sessionCompactSchema,
    sessionContextInfo: sessionContextInfoSchema,
    providersList: providersListSchema,
    providersRevealKey: providersRevealKeySchema,
    providerListModels: providerListModelsSchema,
    providerTestConnection: providerTestConnectionSchema,
    settingsGet: settingsGetSchema,
    settingsWrite: settingsWriteSchema,
    configPatch: configPatchSchema,
    extensionsStatus: extensionsStatusSchema,
    channelsList: channelsListSchema,
    channelsListConversations: channelsListConversationsSchema,
    channelsCreate: channelsCreateSchema,
    channelsBind: channelsBindSchema,
    channelsSubmitVerifyCode: channelsSubmitVerifyCodeSchema,
    channelsUnbind: channelsUnbindSchema,
    channelsRetry: channelsRetrySchema,
    imPolicyGet: imPolicyGetSchema,
    imPolicySetChannelDefault: imPolicySetChannelDefaultSchema,
    imPolicySetChatOverride: imPolicySetChatOverrideSchema,
    imPolicyClearChatOverride: imPolicyClearChatOverrideSchema,
    commandPermissionResolve: commandPermissionResolveSchema,
    toolsList: toolsListSchema,
    agentsList: agentsListSchema,
    agentsContent: agentsContentSchema,
    agentsWrite: agentsWriteSchema,
    agentsDelete: agentsDeleteSchema,
    skillsList: skillsListSchema,
    skillContent: skillContentSchema,
    checkpointsList: checkpointsListSchema,
    checkpointsRestore: checkpointsRestoreSchema,
    memoryList: memoryListSchema,
    memoryWrite: memoryWriteSchema,
    memoryDeleteTopic: memoryDeleteTopicSchema,
    memoryRestoreTopic: memoryRestoreTopicSchema,
    memoryUpsert: memoryUpsertSchema,
    memoryDreamRun: memoryDreamRunSchema,
    memoryDreamApply: memoryDreamApplySchema,
    memoryDreamDiscard: memoryDreamDiscardSchema,
    memoryDreamUndo: memoryDreamUndoSchema,
    mcpListServers: mcpListServersSchema,
    mcpGetConfig: mcpGetConfigSchema,
    mcpCreateConfig: mcpCreateConfigSchema,
    mcpUpdateConfig: mcpUpdateConfigSchema,
    mcpDeleteConfig: mcpDeleteConfigSchema,
    jobsList: jobsListSchema,
    jobsGet: jobsGetSchema,
    jobsCreate: jobsCreateSchema,
    jobsUpdate: jobsUpdateSchema,
    jobsDelete: jobsDeleteSchema,
    jobsRunNow: jobsRunNowSchema,
    jobsHistory: jobsHistorySchema,
};

/**
 * The same shape with every `readonly` modifier dropped.
 *
 * The wire types declare their fields `readonly`, while a typebox schema
 * describes a mutable object. The two are the same value at runtime, but
 * `readonly string[]` is not assignable to `string[]`, so comparing the
 * types directly would report a mismatch for every readonly field. Dropping
 * the modifiers compares the shapes that actually travel the wire.
 *
 * The primitive branch comes first on purpose: a branded id (`WorkspaceId`,
 * `SessionId`) is a string intersected with a brand, and mapping over it as
 * an object would replace the string with an object of its members.
 */
type DeepMutable<T> = T extends string | number | boolean | symbol | bigint | null | undefined
    ? T
    : T extends readonly (infer U)[]
      ? DeepMutable<U>[]
      : T extends object
        ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
        : T;

/**
 * Whether a schema's static type names any field at all.
 *
 * `Type.Any()` and `Type.Unknown()` accept every value, so their static type
 * is `any`/`unknown` and says nothing about which fields exist. Comparing
 * against them would report a mismatch for every method; the check therefore
 * only applies once a schema names its fields.
 */
type SchemaHasShape<S> = unknown extends S ? false : true;

/**
 * The methods whose schema rejects values their contract declares legal.
 *
 * `Params<K> extends Static<schema>` is the check that matters: every value
 * the contract's params type permits must be a value the schema accepts. A
 * schema that requires a field the contract says is optional fails here —
 * the exact `jobs.create` shape where the schema demanded an `id` that no
 * caller sends.
 *
 * Comparing only the outer keys would not catch that: the contract and the
 * schema both have a `job` property, and the disagreement lives one level
 * down. Assignability walks the whole shape.
 *
 * The check is one-directional by construction: it rejects a schema that is
 * *stricter* than the contract, but a schema loosened beyond the contract —
 * a required field turned optional, a narrowed enum widened — still
 * compiles. Loosening a schema is a runtime behaviour change that this
 * assertion cannot see, so it has to be reviewed on its own. The methods
 * that carry real validation today (`jobs.*`) also validate inside their
 * handlers, which is what catches a loosened schema at runtime.
 */
type SchemaRejects<K extends RpcContractKey> = K extends unknown
    ? SchemaHasShape<Static<(typeof rpcSchemas)[K]>> extends true
        ? DeepMutable<RpcParams<K>> extends Static<(typeof rpcSchemas)[K]>
            ? never
            : K
        : never
    : never;

/**
 * The methods whose schema rejects values their contract declares legal.
 *
 * The conditional distributes over the key union, so each method is checked
 * with a *concrete* key — inside a mapped type the key stays generic,
 * `RpcParams<K>` never resolves, and the check silently passes for every
 * method. Distributing here is what makes the verdict meaningful, and it
 * covers a newly added method without touching this file.
 */
type SchemaRejectsSome = SchemaRejects<RpcContractKey>;

/**
 * Compile-time proof that every method's schema accepts its contract's params.
 *
 * The assignment below is the assertion: `false` is not assignable to `true`,
 * so a drift fails the build. A type alias alone would not — an unreferenced
 * alias that resolves to `never` compiles fine, which is how a schema that
 * dropped a field could reach a release unnoticed.
 */
export const schemasAgreeWithParams: [SchemaRejectsSome] extends [never] ? true : false = true;

/**
 * Compile-time proof that the constant table and the contract table list the
 * same methods. Assigned rather than aliased for the same reason as above.
 */
export const contractKeysMatchRpcKeys: [RpcContractKey, keyof typeof RPC] extends [infer A, infer B]
    ? [A] extends [B]
        ? [B] extends [A]
            ? true
            : false
        : false
    : false = true;
