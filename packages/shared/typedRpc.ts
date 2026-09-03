/**
 * @taco-ai/shared — typed RPC surface factory.
 *
 * Defines the 20 typed RPC wrappers once, used by every client. Each
 * transport (Node child_process, Tauri sidecar) implements `RpcDispatch`
 * and passes it here. Params/Result come from `@taco-ai/protocol` directly.
 *
 * 12 of 20 methods use four helpers (ws0 / wsSession / process0 / process1);
 * the remaining 8 are inlined for non-standard param shapes.
 */

import type {
    AbortResult,
    AgentsContentParams,
    AgentsContentResult,
    AgentsListResult,
    AttachParams,
    ChannelsBindParams,
    ChannelsBindResult,
    ChannelsCreateParams,
    ChannelsCreateResult,
    ChannelsListConversationsParams,
    ChannelsListConversationsResult,
    ChannelsListResult,
    ChannelsRetryParams,
    ChannelsRetryResult,
    ChannelsSubmitVerifyCodeParams,
    ChannelsSubmitVerifyCodeResult,
    ChannelsUnbindParams,
    ChannelsUnbindResult,
    CheckpointsListParams,
    CheckpointsListResult,
    CheckpointsRestoreParams,
    CheckpointsRestoreResult,
    ClientCapabilities,
    CommandPermissionResolveParams,
    CommandPermissionResolveResult,
    CreateSessionParams,
    CreateSessionResult,
    ExtensionsStatusResult,
    ImageInput,
    ImPolicyClearChatOverrideParams,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImPolicySetChannelDefaultParams,
    ImPolicySetChatOverrideParams,
    ImPolicyWriteResult,
    InitializeParams,
    InitializeResult,
    ListModelsParams,
    McpCreateConfigParams,
    McpDeleteConfigParams,
    McpDeleteConfigResult,
    McpGetConfigParams,
    McpGetConfigResult,
    McpListServersResult,
    McpMutateConfigResult,
    McpServerConfig,
    McpUpdateConfigParams,
    MemoryDeleteTopicParams,
    MemoryDeleteTopicResult,
    MemoryListResult,
    MemoryUpsertParams,
    MemoryUpsertResult,
    MemoryWriteParams,
    MemoryWriteResult,
    PlanStateUpdatedParams,
    PromptParams,
    PromptResult,
    ProviderListModelsParams,
    ProviderListModelsResult,
    ProvidersListParams,
    ProvidersListResult,
    RenameSessionParams,
    SessionCompactParams,
    SessionCompactResult,
    SessionContextInfoParams,
    SessionContextInfoResult,
    SessionEventsGetParams,
    SessionEventsGetResult,
    SessionHistory,
    SessionId,
    SessionListParams,
    SessionListResult,
    SessionSetThinkingLevelParams,
    SessionSnapshot,
    SessionSnapshotGetParams,
    SetModelParams,
    SettingsGetResult,
    SettingsWriteParams,
    SettingsWriteResult,
    SkillContentResult,
    SkillsListResult,
    SteerParams,
    SubmitAnswersParams,
    SupportedLocale,
    TaskItem,
    TasksUpdatedParams,
    ThinkingLevel,
    ToolsListResult,
    WorkspaceId,
} from "@taco-ai/protocol";
import { RPC } from "./rpcMethods.js";

/**
 * Abstract dispatch — one implementation per transport.
 *
 * `call`: workspace-scoped; the transport selects the channel per call (e.g. Tauri invoke).
 * `callProcess`: process-level (settings.* / workspace.list); the transport chooses routing
 *   (e.g. Tauri reuses any ensured cwd; Node uses the single instance process).
 */
export interface RpcDispatch {
    call<TParams = void, TResult = unknown>(
        method: string,
        workspace: WorkspaceId,
        params: TParams,
    ): Promise<TResult>;
    callProcess<TParams = void, TResult = unknown>(
        method: string,
        params: TParams,
    ): Promise<TResult>;
}

export interface TypedRpc {
    // ── initialize (process-level bootstrap, no workspace) ──
    /**
     * First client → server request on a connection. The server validates
     * `protocolVersion` (major must match, server.minor >= client.minor) and
     * stores `clientCapabilities`. Calling any other RPC before initialize
     * succeeds returns `not_initialized`.
     */
    initialize(
        protocolVersion: InitializeParams["protocolVersion"],
        clientCapabilities?: ClientCapabilities,
    ): Promise<InitializeResult>;

    // ── workspace ──
    workspaceList(): Promise<WorkspaceId[]>;
    workspaceEnsure(cwd: WorkspaceId): Promise<{ cwd: WorkspaceId }>;
    workspaceDispose(cwd: WorkspaceId): Promise<null>;

    // ── session ──
    sessionList(
        workspace: WorkspaceId,
        opts?: Omit<SessionListParams, "workspace">,
    ): Promise<SessionListResult>;
    sessionCreate(args: CreateSessionParams): Promise<CreateSessionResult>;
    sessionAttach(
        workspace: WorkspaceId,
        sessionId: SessionId,
        opts?: { thinkingLevel?: ThinkingLevel },
    ): Promise<{
        attached: true;
        sessionId: SessionId;
        /**
         * parentToolCallIds whose subagent is running in the sidecar right now.
         * Absent on older sidecars. Process-memory state, so a fresh process
         * reports none — which is what lets a client expire agent tool cards
         * orphaned by a previous process exit without touching live ones.
         */
        inFlightAgentToolCallIds?: string[];
    }>;
    sessionDetach(workspace: WorkspaceId, sessionId: SessionId): Promise<{ detached: true }>;
    sessionDelete(workspace: WorkspaceId, sessionId: SessionId): Promise<unknown>;
    sessionRename(workspace: WorkspaceId, sessionId: SessionId, name: string): Promise<unknown>;
    sessionHistory(workspace: WorkspaceId, sessionId: SessionId): Promise<SessionHistory>;
    /** Replay retained realtime frames after a session cursor. */
    sessionEventsGet(
        workspace: WorkspaceId,
        sessionId: SessionId,
        afterSeq: number,
    ): Promise<SessionEventsGetResult>;
    /** Pull one consistent state snapshot and its replay watermark. */
    sessionSnapshotGet(workspace: WorkspaceId, sessionId: SessionId): Promise<SessionSnapshot>;
    /**
     * Fetch the task list snapshot for the attached session — push fallback.
     */
    sessionTasksGet(
        workspace: WorkspaceId,
        sessionId: SessionId,
    ): Promise<Pick<TasksUpdatedParams, "active" | "history">>;
    /**
     * Fetch the full task items for a given history list — push fallback, expanded on demand
     * (history pushes meta only).
     */
    sessionTaskHistoryGet(
        workspace: WorkspaceId,
        sessionId: SessionId,
        listId: string,
    ): Promise<TaskItem[]>;
    /**
     * Fetch the plan-mode state snapshot for the attached session — push fallback.
     */
    sessionPlanStateGet(
        workspace: WorkspaceId,
        sessionId: SessionId,
    ): Promise<Pick<PlanStateUpdatedParams, "active" | "currentSlug">>;
    sessionPrompt(
        workspace: WorkspaceId,
        sessionId: SessionId,
        text: string,
        images?: ImageInput[],
        uiLocale?: SupportedLocale,
        model?: { provider: string; id: string },
    ): Promise<PromptResult>;
    sessionSteer(workspace: WorkspaceId, sessionId: SessionId, text: string): Promise<null>;
    /**
     * Submit askUser answers — sidecar injects <ask_user_context> into the user message.
     * The client does not need to know the tag wire format, only the structured answers.
     */
    sessionSubmitAnswers(
        workspace: WorkspaceId,
        sessionId: SessionId,
        toolCallId: string,
        answers: Record<string, string | string[]>,
        toolName?: string,
    ): Promise<null>;
    sessionAbort(workspace: WorkspaceId, sessionId: SessionId): Promise<AbortResult>;
    sessionSetModel(
        workspace: WorkspaceId,
        sessionId: SessionId,
        provider: string,
        modelId: string,
    ): Promise<{ switchedTo: { provider: string; modelId: string } }>;
    sessionListModels(
        workspace: WorkspaceId,
        provider?: string,
    ): Promise<{ models: Array<{ provider: string; id: string; name?: string }> }>;
    /** List the availability view of built-in providers (configured + models) for the Model settings UI. */
    providersList(workspace: WorkspaceId): Promise<ProvidersListResult>;
    sessionSetThinkingLevel(
        workspace: WorkspaceId,
        sessionId: SessionId,
        level: ThinkingLevel,
    ): Promise<unknown>;
    /**
     * Manually trigger compaction. Returns `ok` plus optional token stats.
     * Auto-trigger runs in the sidecar after `settled`; this RPC is the UI button / command palette entry point.
     */
    sessionCompact(
        workspace: WorkspaceId,
        sessionId: SessionId,
        customInstructions?: string,
    ): Promise<SessionCompactResult>;
    /**
     * Fetch current session context info (tokens used, model window, ratio, last compact time).
     * The authoritative data source for the desktop top-bar indicator.
     */
    sessionContextInfo(
        workspace: WorkspaceId,
        sessionId: SessionId,
    ): Promise<SessionContextInfoResult>;
    commandPermissionResolve(
        workspace: WorkspaceId,
        params: Omit<CommandPermissionResolveParams, "workspace">,
    ): Promise<CommandPermissionResolveResult>;

    // ── settings(process-level)──
    /** Fetch sidecar global config + client-local settings (sidecar RPC + local read merged). */
    settingsGet(): Promise<SettingsGetResult>;
    /** Write sidecar global config to ~/.taco/taco.json. */
    settingsWrite(params: SettingsWriteParams): Promise<SettingsWriteResult>;

    // ── extensions(process-level)──
    /** Fetches extension load status (loaded / failed / unauthorized / disabled) */
    extensionsStatus(): Promise<ExtensionsStatusResult>;

    // ── channels(process-level)──
    /** Lists instantiable channel types plus configured instances and their state. */
    channelsList(): Promise<ChannelsListResult>;
    /** Enumerates routed IM conversations, optionally filtered by channelId. */
    channelsListConversations(
        params?: ChannelsListConversationsParams,
    ): Promise<ChannelsListConversationsResult>;
    /** Declares a new channel instance in taco.json. Takes effect on restart. */
    channelsCreate(params: ChannelsCreateParams): Promise<ChannelsCreateResult>;
    /** Starts the bind flow. Progress arrives via `channel.status_changed` pushes. */
    channelsBind(params: ChannelsBindParams): Promise<ChannelsBindResult>;
    /** Answers a pending pairing-code prompt. */
    channelsSubmitVerifyCode(
        params: ChannelsSubmitVerifyCodeParams,
    ): Promise<ChannelsSubmitVerifyCodeResult>;
    /** Drops stored credentials and stops the channel. */
    channelsUnbind(params: ChannelsUnbindParams): Promise<ChannelsUnbindResult>;
    /** Reconnect using the channel's already-stored credentials. For platforms
     *  where the SDK caches the credential in its long-poll client and refuses
     *  to retry past its reconnect budget — the only way back from error
     *  without retyping the secret. */
    channelsRetry(params: ChannelsRetryParams): Promise<ChannelsRetryResult>;

    // ── imPolicy (process-level) ──
    /** Fetch the channel's raw default + the resolved policy for the requested scope,
     *  plus the chat override (if peerId+chatId) and a list of all overrides for the
     *  channel (live + orphan). */
    imPolicyGet(params: ImPolicyGetParams): Promise<ImPolicyGetResult>;
    /** Merge a patch over the channel default; omitted fields are preserved. */
    imPolicySetChannelDefault(
        params: ImPolicySetChannelDefaultParams,
    ): Promise<ImPolicyWriteResult>;
    /** Merge a patch over a specific chat's override; omitted fields are preserved. */
    imPolicySetChatOverride(params: ImPolicySetChatOverrideParams): Promise<ImPolicyWriteResult>;
    /** Drop a chat override entirely (reverts that chat to the channel default). */
    imPolicyClearChatOverride(
        params: ImPolicyClearChatOverrideParams,
    ): Promise<ImPolicyWriteResult>;

    // ── provider (process-level, config-only helpers) ──
    /** Fetch the model id list from a custom provider's `/v1/models`. */
    providerListModels(params: ProviderListModelsParams): Promise<ProviderListModelsResult>;

    // ── tools ──
    toolsList(workspace: WorkspaceId): Promise<ToolsListResult>;

    // ── agents ──
    agentsList(workspace: WorkspaceId): Promise<AgentsListResult>;
    agentsContent(workspace: WorkspaceId, agentType: string): Promise<AgentsContentResult>;

    // ── skills ──
    skillsList(workspace: WorkspaceId): Promise<SkillsListResult>;
    skillContent(workspace: WorkspaceId, filePath: string): Promise<SkillContentResult>;

    // ── memory ──
    /** List restore points, newest first. Omit `sessionId` for the whole workspace. */
    checkpointsList(workspace: WorkspaceId, sessionId?: SessionId): Promise<CheckpointsListResult>;
    /** Roll files back to a checkpoint. Destructive; snapshots current state first. */
    checkpointsRestore(
        workspace: WorkspaceId,
        checkpointId: string,
        sessionId?: SessionId,
    ): Promise<CheckpointsRestoreResult>;
    memoryList(workspace: WorkspaceId): Promise<MemoryListResult>;
    memoryWrite(
        workspace: WorkspaceId,
        content: string,
        baseHash: string,
    ): Promise<MemoryWriteResult>;
    memoryDeleteTopic(workspace: WorkspaceId, id: string): Promise<MemoryDeleteTopicResult>;
    memoryUpsert(
        workspace: WorkspaceId,
        action: "add" | "replace" | "remove",
        params: {
            id: string;
            name?: string;
            content?: string;
            type?: "user" | "feedback" | "project" | "reference";
        },
    ): Promise<MemoryUpsertResult>;

    // ── mcp (process-level) ──
    /**
     * Probe configured MCP servers for connectivity and tool list. Disabled
     * servers short-circuit to `status: "skipped"` without spawning; pass
     * `forceProbe: true` to override.
     */
    mcpListServers(params?: {
        ids?: string[];
        forceProbe?: boolean;
    }): Promise<McpListServersResult>;
    /** Fetch one raw MCP server config for editing — the only path that returns
     *  command/args/env/headers/url for a single server. */
    mcpGetConfig(id: string): Promise<McpGetConfigResult>;
    /** Add an MCP server; validates id uniqueness. */
    mcpCreateConfig(config: McpServerConfig): Promise<McpMutateConfigResult>;
    /** Field-wise update of one MCP server; absent fields keep their current value. */
    mcpUpdateConfig(id: string, patch: Partial<McpServerConfig>): Promise<McpMutateConfigResult>;
    /** Delete an MCP server by id. */
    mcpDeleteConfig(id: string): Promise<McpDeleteConfigResult>;
}

// ─────────────────────────────────────────────────────────────────────
// Generic helpers — four common param shapes, one helper per shape.
// Helpers collapse each wrapper to one line; only methods with non-standard param shapes stay inline.
// ─────────────────────────────────────────────────────────────────────

/** Workspace-scoped, params = `{ workspace }` (workspace field only). */
function ws0<R>(call: RpcDispatch["call"], method: string): (workspace: WorkspaceId) => Promise<R> {
    return (workspace) => call<{ workspace: WorkspaceId }, R>(method, workspace, { workspace });
}

/** Workspace-scoped, params = `{ workspace, sessionId }` (2 fields). */
function wsSession<R>(
    call: RpcDispatch["call"],
    method: string,
): (workspace: WorkspaceId, sessionId: SessionId) => Promise<R> {
    return (workspace, sessionId) =>
        call<{ workspace: WorkspaceId; sessionId: SessionId }, R>(method, workspace, {
            workspace,
            sessionId,
        });
}

/** Workspace + session + listId (3 fields) — used to fetch history list details. */
function wsSessionWithListId<R>(
    call: RpcDispatch["call"],
    method: string,
): (workspace: WorkspaceId, sessionId: SessionId, listId: string) => Promise<R> {
    return (workspace, sessionId, listId) =>
        call<{ workspace: WorkspaceId; sessionId: SessionId; listId: string }, R>(
            method,
            workspace,
            { workspace, sessionId, listId },
        );
}

/** Process-level, no params (e.g. settings.get). */
function process0<R>(callProcess: RpcDispatch["callProcess"], method: string): () => Promise<R> {
    return () => callProcess<undefined, R>(method, undefined);
}

/** Process-level, one param passed as params (e.g. settings.write). */
function process1<P, R>(
    callProcess: RpcDispatch["callProcess"],
    method: string,
): (params: P) => Promise<R> {
    return (params) => callProcess<P, R>(method, params);
}

export function createTypedRpc(dispatch: RpcDispatch): TypedRpc {
    const call = dispatch.call;
    const callProcess = dispatch.callProcess;

    return {
        // ── initialize (process-level bootstrap) ──
        initialize: (protocolVersion, clientCapabilities) =>
            callProcess<InitializeParams, InitializeResult>(RPC.initialize, {
                protocolVersion,
                clientCapabilities: clientCapabilities ?? {},
            }),

        // ── workspace ──
        workspaceList: process0<WorkspaceId[]>(callProcess, RPC.workspaceList),

        // workspaceEnsure / workspaceDispose use `cwd` (not `workspace`), so they don't match ws0.
        workspaceEnsure: (cwd) =>
            call<{ cwd: WorkspaceId }, { cwd: WorkspaceId }>(RPC.workspaceEnsure, cwd, { cwd }),
        workspaceDispose: (cwd) =>
            call<{ cwd: WorkspaceId }, null>(RPC.workspaceDispose, cwd, { cwd }),

        // ── session ──
        sessionList: (workspace, opts) =>
            call<{ workspace: WorkspaceId } & SessionListParams, SessionListResult>(
                RPC.sessionList,
                workspace,
                { workspace, ...(opts ?? {}) },
            ),

        // sessionCreate: args go straight to params (workspace is inside args)
        sessionCreate: (args) =>
            call<CreateSessionParams, CreateSessionResult>(RPC.sessionCreate, args.workspace, args),

        // sessionAttach: workspace + sessionId + optional opts spread
        sessionAttach: (workspace, sessionId, opts) =>
            call<AttachParams, { attached: true; sessionId: SessionId }>(
                RPC.sessionAttach,
                workspace,
                { workspace, sessionId, ...(opts ?? {}) },
            ),

        sessionDetach: wsSession<{ detached: true }>(call, RPC.sessionDetach),
        sessionDelete: wsSession<unknown>(call, RPC.sessionDelete),

        // sessionRename: workspace + sessionId + name (one extra `name` beyond wsSession)
        sessionRename: (workspace, sessionId, name) =>
            call<RenameSessionParams, unknown>(RPC.sessionRename, workspace, {
                workspace,
                sessionId,
                name,
            }),
        sessionHistory: wsSession<SessionHistory>(call, RPC.sessionHistory),
        sessionEventsGet: (workspace, sessionId, afterSeq) =>
            call<SessionEventsGetParams, SessionEventsGetResult>(RPC.sessionEventsGet, workspace, {
                workspace,
                sessionId,
                afterSeq,
            }),
        sessionSnapshotGet: (workspace, sessionId) =>
            call<SessionSnapshotGetParams, SessionSnapshot>(RPC.sessionSnapshotGet, workspace, {
                workspace,
                sessionId,
            }),
        // sessionTasksGet: returns the current task list snapshot; push fallback
        sessionTasksGet: wsSession<Pick<TasksUpdatedParams, "active" | "history">>(
            call,
            RPC.sessionTasksGet,
        ),
        // sessionTaskHistoryGet: lazily fetches the full task items for a history list.
        sessionTaskHistoryGet: wsSessionWithListId<TaskItem[]>(call, RPC.sessionTaskHistoryGet),
        // sessionPlanStateGet: returns the current plan-mode state snapshot; push fallback
        sessionPlanStateGet: wsSession<Pick<PlanStateUpdatedParams, "active" | "currentSlug">>(
            call,
            RPC.sessionPlanStateGet,
        ),

        // sessionPrompt: workspace + sessionId + text + optional images + optional uiLocale
        sessionPrompt: (workspace, sessionId, text, images, uiLocale, model) =>
            call<PromptParams, PromptResult>(RPC.sessionPrompt, workspace, {
                workspace,
                sessionId,
                text,
                ...(images && images.length > 0 ? { images } : {}),
                ...(uiLocale ? { uiLocale } : {}),
                ...(model ? { model } : {}),
            }),

        // sessionSteer: workspace + sessionId + text
        sessionSteer: (workspace, sessionId, text) =>
            call<SteerParams, null>(RPC.sessionSteer, workspace, { workspace, sessionId, text }),

        // sessionSubmitAnswers: workspace + sessionId + toolCallId + answers + optional toolName
        sessionSubmitAnswers: (workspace, sessionId, toolCallId, answers, toolName) =>
            call<SubmitAnswersParams, null>(RPC.sessionSubmitAnswers, workspace, {
                workspace,
                sessionId,
                toolCallId,
                answers,
                ...(toolName ? { toolName } : {}),
            }),

        sessionAbort: wsSession<AbortResult>(call, RPC.sessionAbort),

        // sessionSetModel: workspace + sessionId + provider + modelId
        sessionSetModel: (workspace, sessionId, provider, modelId) =>
            call<SetModelParams, { switchedTo: { provider: string; modelId: string } }>(
                RPC.sessionSetModel,
                workspace,
                { workspace, sessionId, provider, modelId },
            ),

        // sessionListModels: workspace + optional provider
        sessionListModels: (workspace, provider) =>
            call<
                ListModelsParams,
                {
                    models: Array<{ provider: string; id: string; name?: string }>;
                }
            >(RPC.sessionListModels, workspace, { workspace, provider }),

        // providersList: workspace → built-in provider availability view
        providersList: (workspace) =>
            call<ProvidersListParams, ProvidersListResult>(RPC.providersList, workspace, {
                workspace,
            }),

        // sessionSetThinkingLevel: workspace + sessionId + level
        sessionSetThinkingLevel: (workspace, sessionId, level) =>
            call<SessionSetThinkingLevelParams, unknown>(RPC.sessionSetThinkingLevel, workspace, {
                workspace,
                sessionId,
                level,
            }),

        // sessionCompact: workspace + sessionId + optional customInstructions
        sessionCompact: (workspace, sessionId, customInstructions) =>
            call<SessionCompactParams, SessionCompactResult>(RPC.sessionCompact, workspace, {
                workspace,
                sessionId,
                // Omit `customInstructions` from the RPC frame when absent, avoiding an undefined placeholder.
                ...(customInstructions ? { customInstructions } : {}),
            }),

        // sessionContextInfo: workspace + sessionId snapshot
        sessionContextInfo: (workspace, sessionId) =>
            call<SessionContextInfoParams, SessionContextInfoResult>(
                RPC.sessionContextInfo,
                workspace,
                { workspace, sessionId },
            ),
        commandPermissionResolve: (workspace, params) =>
            call<CommandPermissionResolveParams, CommandPermissionResolveResult>(
                RPC.commandPermissionResolve,
                workspace,
                { workspace, ...params },
            ),

        // ── settings(process-level)──
        settingsGet: process0<SettingsGetResult>(callProcess, RPC.settingsGet),
        settingsWrite: process1<SettingsWriteParams, SettingsWriteResult>(
            callProcess,
            RPC.settingsWrite,
        ),

        // ── extensions(process-level)──
        extensionsStatus: process0<ExtensionsStatusResult>(callProcess, RPC.extensionsStatus),
        channelsList: process0<ChannelsListResult>(callProcess, RPC.channelsList),
        channelsListConversations: process1<
            ChannelsListConversationsParams,
            ChannelsListConversationsResult
        >(callProcess, RPC.channelsListConversations),
        channelsCreate: process1<ChannelsCreateParams, ChannelsCreateResult>(
            callProcess,
            RPC.channelsCreate,
        ),
        channelsBind: process1<ChannelsBindParams, ChannelsBindResult>(
            callProcess,
            RPC.channelsBind,
        ),
        channelsSubmitVerifyCode: process1<
            ChannelsSubmitVerifyCodeParams,
            ChannelsSubmitVerifyCodeResult
        >(callProcess, RPC.channelsSubmitVerifyCode),
        channelsUnbind: process1<ChannelsUnbindParams, ChannelsUnbindResult>(
            callProcess,
            RPC.channelsUnbind,
        ),
        channelsRetry: process1<ChannelsRetryParams, ChannelsRetryResult>(
            callProcess,
            RPC.channelsRetry,
        ),

        // ── imPolicy (process-level) ──
        imPolicyGet: process1<ImPolicyGetParams, ImPolicyGetResult>(callProcess, RPC.imPolicyGet),
        imPolicySetChannelDefault: process1<ImPolicySetChannelDefaultParams, ImPolicyWriteResult>(
            callProcess,
            RPC.imPolicySetChannelDefault,
        ),
        imPolicySetChatOverride: process1<ImPolicySetChatOverrideParams, ImPolicyWriteResult>(
            callProcess,
            RPC.imPolicySetChatOverride,
        ),
        imPolicyClearChatOverride: process1<ImPolicyClearChatOverrideParams, ImPolicyWriteResult>(
            callProcess,
            RPC.imPolicyClearChatOverride,
        ),

        // ── provider (process-level, config-only helpers) ──
        providerListModels: process1<ProviderListModelsParams, ProviderListModelsResult>(
            callProcess,
            RPC.providerListModels,
        ),

        // ── tools ──
        toolsList: ws0<ToolsListResult>(call, RPC.toolsList),

        // ── agents ──
        agentsList: ws0<AgentsListResult>(call, RPC.agentsList),

        // agentsContent: workspace + agentType
        agentsContent: (workspace, agentType) =>
            call<AgentsContentParams, AgentsContentResult>(RPC.agentsContent, workspace, {
                workspace,
                agentType,
            }),

        // ── skills ──
        skillsList: ws0<SkillsListResult>(call, RPC.skillsList),

        // skillContent: workspace + filePath
        skillContent: (workspace, filePath) =>
            call<{ workspace: WorkspaceId; filePath: string }, SkillContentResult>(
                RPC.skillContent,
                workspace,
                { workspace, filePath },
            ),

        // ── checkpoints ──
        checkpointsList: (workspace, sessionId) =>
            call<CheckpointsListParams, CheckpointsListResult>(RPC.checkpointsList, workspace, {
                workspace,
                sessionId,
            }),

        checkpointsRestore: (workspace, checkpointId, sessionId) =>
            call<CheckpointsRestoreParams, CheckpointsRestoreResult>(
                RPC.checkpointsRestore,
                workspace,
                { workspace, checkpointId, sessionId },
            ),

        // ── memory ──
        memoryList: ws0<MemoryListResult>(call, RPC.memoryList),

        memoryWrite: (workspace, content, baseHash) =>
            call<MemoryWriteParams, MemoryWriteResult>(RPC.memoryWrite, workspace, {
                workspace,
                content,
                baseHash,
            }),

        memoryDeleteTopic: (workspace, id) =>
            call<MemoryDeleteTopicParams, MemoryDeleteTopicResult>(
                RPC.memoryDeleteTopic,
                workspace,
                { workspace, id },
            ),

        memoryUpsert: (workspace, action, params) =>
            call<MemoryUpsertParams, MemoryUpsertResult>(RPC.memoryUpsert, workspace, {
                workspace,
                action,
                id: params.id,
                name: params.name,
                content: params.content,
                type: params.type,
            }),

        // ── mcp (process-level) ──
        mcpListServers: (params) =>
            callProcess<{ ids?: string[]; forceProbe?: boolean }, McpListServersResult>(
                RPC.mcpListServers,
                params ?? {},
            ),
        mcpGetConfig: (id) =>
            callProcess<McpGetConfigParams, McpGetConfigResult>(RPC.mcpGetConfig, { id }),
        mcpCreateConfig: (config) =>
            callProcess<McpCreateConfigParams, McpMutateConfigResult>(RPC.mcpCreateConfig, {
                config,
            }),
        mcpUpdateConfig: (id, patch) =>
            callProcess<McpUpdateConfigParams, McpMutateConfigResult>(RPC.mcpUpdateConfig, {
                id,
                patch,
            }),
        mcpDeleteConfig: (id) =>
            callProcess<McpDeleteConfigParams, McpDeleteConfigResult>(RPC.mcpDeleteConfig, { id }),
    };
}
