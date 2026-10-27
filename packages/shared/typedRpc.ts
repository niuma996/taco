/**
 * @taco-ai/shared — typed RPC surface factory.
 *
 * Defines the typed RPC facade once, used by every client. Each
 * transport (Node child_process, Tauri sidecar) implements `RpcDispatch`
 * and passes it here. Params/Result come from `@taco-ai/protocol` directly.
 *
 * All sends use the contract-bound dispatcher; explicit adapters preserve the
 * public facade arguments while the method determines payload and result types.
 */

import type {
    AbortResult,
    AgentsContentResult,
    AgentsDeleteResult,
    AgentsListResult,
    AgentsWriteParams,
    AgentsWriteResult,
    CancelQueuedResult,
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
    CheckpointsListResult,
    CheckpointsRestoreResult,
    ClientCapabilities,
    CommandPermissionResolveParams,
    CommandPermissionResolveResult,
    CreateSessionParams,
    CreateSessionResult,
    ExtensionsStatusResult,
    FollowUpResult,
    ImageInput,
    ImPolicyClearChatOverrideParams,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImPolicySetChannelDefaultParams,
    ImPolicySetChatOverrideParams,
    ImPolicyWriteResult,
    InitializeParams,
    InitializeResult,
    McpDeleteConfigResult,
    McpGetConfigResult,
    McpListServersParams,
    McpListServersResult,
    McpMutateConfigResult,
    McpServerConfig,
    MemoryDeleteTopicResult,
    MemoryDreamApplyResult,
    MemoryDreamDiscardResult,
    MemoryDreamRunResult,
    MemoryDreamUndoResult,
    MemoryListResult,
    MemoryRestoreTopicResult,
    MemoryUpsertResult,
    MemoryWriteResult,
    PromptResult,
    ProviderListModelsParams,
    ProviderListModelsResult,
    ProvidersListResult,
    ProvidersRevealKeyResult,
    ProviderTestConnectionParams,
    ProviderTestConnectionResult,
    RpcContractKey,
    SessionAttachResult,
    SessionCompactResult,
    SessionContextInfoResult,
    SessionDeleteResult,
    SessionDetachResult,
    SessionEventsGetResult,
    SessionHistory,
    SessionId,
    SessionListModelsResult,
    SessionListParams,
    SessionListResult,
    SessionPlanStateGetResult,
    SessionRenameResult,
    SessionSetModelResult,
    SessionSetThinkingLevelResult,
    SessionSnapshot,
    SessionTaskHistoryGetResult,
    SessionTasksGetResult,
    SettingsGetResult,
    SettingsWriteParams,
    SettingsWriteResult,
    SkillContentResult,
    SkillsListResult,
    SteerResult,
    SubagentAbortResult,
    SupportedLocale,
    ThinkingLevel,
    ToolsListResult,
    WorkspaceAssociationKey,
    WorkspaceAssociationsGetResult,
    WorkspaceAssociationsResolveResult,
    WorkspaceAssociationsSetResult,
    WorkspaceDisposeResult,
    WorkspaceEnsureResult,
    WorkspaceId,
} from "@taco-ai/protocol";
import { asToolCallId } from "@taco-ai/protocol";
import { createContractDispatch, type RpcDispatch } from "./contractDispatch.js";
import { RPC } from "./rpcMethods.js";

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
    workspaceEnsure(cwd: WorkspaceId): Promise<WorkspaceEnsureResult>;
    workspaceDispose(cwd: WorkspaceId): Promise<WorkspaceDisposeResult>;
    /** Read the associated-directory set stored at one key. */
    workspaceAssociationsGet(key: WorkspaceAssociationKey): Promise<WorkspaceAssociationsGetResult>;
    /** Replace the associated-directory set stored at one key. */
    workspaceAssociationsSet(
        key: WorkspaceAssociationKey,
        roots: readonly string[],
    ): Promise<WorkspaceAssociationsSetResult>;
    /** The effective associated-directory set for a workspace, after the scope fallback. */
    workspaceAssociationsResolve(
        workspace: WorkspaceId,
    ): Promise<WorkspaceAssociationsResolveResult>;

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
    ): Promise<SessionAttachResult>;
    sessionDetach(workspace: WorkspaceId, sessionId: SessionId): Promise<SessionDetachResult>;
    sessionDelete(workspace: WorkspaceId, sessionId: SessionId): Promise<SessionDeleteResult>;
    sessionRename(
        workspace: WorkspaceId,
        sessionId: SessionId,
        name: string,
    ): Promise<SessionRenameResult>;
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
    sessionTasksGet(workspace: WorkspaceId, sessionId: SessionId): Promise<SessionTasksGetResult>;
    /**
     * Fetch the full task items for a given history list — push fallback, expanded on demand
     * (history pushes meta only).
     */
    sessionTaskHistoryGet(
        workspace: WorkspaceId,
        sessionId: SessionId,
        listId: string,
    ): Promise<SessionTaskHistoryGetResult>;
    /**
     * Fetch the plan-mode state snapshot for the attached session — push fallback.
     */
    sessionPlanStateGet(
        workspace: WorkspaceId,
        sessionId: SessionId,
    ): Promise<SessionPlanStateGetResult>;
    sessionPrompt(
        workspace: WorkspaceId,
        sessionId: SessionId,
        text: string,
        images?: ImageInput[],
        uiLocale?: SupportedLocale,
        model?: { provider: string; id: string },
    ): Promise<PromptResult>;
    /**
     * Enqueue a mid-run steering message, consumed at the next tool-batch
     * boundary — "interrupt and redirect". Resolves promptly with the enqueue
     * outcome: "queued" (plus the entryId to key an optimistic row on) or
     * "idle" (no active run; the client should fall back to sessionPrompt).
     */
    sessionSteer(
        workspace: WorkspaceId,
        sessionId: SessionId,
        text: string,
        images?: ImageInput[],
        uiLocale?: SupportedLocale,
    ): Promise<SteerResult>;
    /**
     * Like sessionSteer, but consumed only once the run would otherwise finish —
     * "queue behind the current work" rather than "interrupt it". Same result
     * contract, including the idle fallback.
     */
    sessionFollowUp(
        workspace: WorkspaceId,
        sessionId: SessionId,
        text: string,
        images?: ImageInput[],
        uiLocale?: SupportedLocale,
    ): Promise<FollowUpResult>;
    /** Remove one not-yet-consumed queue entry; "already_consumed" / "not_found" are normal outcomes. */
    sessionCancelQueued(
        workspace: WorkspaceId,
        sessionId: SessionId,
        entryId: string,
    ): Promise<CancelQueuedResult>;
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
    /**
     * Stop one running subagent (by child session id) without aborting the
     * parent's turn. `not_running` is a normal outcome, not an error.
     */
    subagentAbort(workspace: WorkspaceId, subSessionId: SessionId): Promise<SubagentAbortResult>;
    sessionSetModel(
        workspace: WorkspaceId,
        sessionId: SessionId,
        provider: string,
        modelId: string,
    ): Promise<SessionSetModelResult>;
    sessionListModels(workspace: WorkspaceId, provider?: string): Promise<SessionListModelsResult>;
    /** List the availability view of built-in providers (configured + models) for the Model settings UI. */
    providersList(workspace: WorkspaceId): Promise<ProvidersListResult>;
    /** Reveal one provider's plaintext API key (settings UI "reveal" toggle). */
    providersRevealKey(
        workspace: WorkspaceId,
        providerId: string,
    ): Promise<ProvidersRevealKeyResult>;
    sessionSetThinkingLevel(
        workspace: WorkspaceId,
        sessionId: SessionId,
        level: ThinkingLevel,
    ): Promise<SessionSetThinkingLevelResult>;
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
    /** Fetch the model id list from a provider's `/models`. */
    providerListModels(params: ProviderListModelsParams): Promise<ProviderListModelsResult>;
    /** Send one minimal chat turn to verify a provider end to end. */
    providerTestConnection(
        params: ProviderTestConnectionParams,
    ): Promise<ProviderTestConnectionResult>;

    // ── tools ──
    toolsList(workspace: WorkspaceId): Promise<ToolsListResult>;

    // ── agents ──
    agentsList(workspace: WorkspaceId): Promise<AgentsListResult>;
    agentsContent(workspace: WorkspaceId, agentType: string): Promise<AgentsContentResult>;
    agentsWrite(
        workspace: WorkspaceId,
        params: Omit<AgentsWriteParams, "workspace">,
    ): Promise<AgentsWriteResult>;
    agentsDelete(workspace: WorkspaceId, agentType: string): Promise<AgentsDeleteResult>;

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
    memoryDeleteTopic(
        workspace: WorkspaceId,
        id: string,
        expectedContent?: string,
    ): Promise<MemoryDeleteTopicResult>;
    /** Move an archived topic back into the live set. */
    memoryRestoreTopic(workspace: WorkspaceId, id: string): Promise<MemoryRestoreTopicResult>;
    /** Consolidate now; always returns a preview, never applies. Model-bound. */
    memoryDreamRun(workspace: WorkspaceId): Promise<MemoryDreamRunResult>;
    /** Apply the reviewed preview; rejected if a newer preview replaced it. */
    memoryDreamApply(workspace: WorkspaceId, previewId: string): Promise<MemoryDreamApplyResult>;
    memoryDreamDiscard(workspace: WorkspaceId): Promise<MemoryDreamDiscardResult>;
    /** Revert one applied consolidation; returns topics left as edited since. */
    memoryDreamUndo(workspace: WorkspaceId, reportId: string): Promise<MemoryDreamUndoResult>;
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
    mcpListServers(params?: McpListServersParams): Promise<McpListServersResult>;
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

/**
 * The ergonomic method facade must cover every contract row. The implementation
 * remains handwritten because it adapts friendly arguments into wire envelopes,
 * but adding a protocol method without adding its client entry now fails here.
 */
// jobs.* belongs to the dedicated scheduler facade, while config.patch is
// invoked internally by the config tool rather than exposed to app clients.
type TypedRpcContractKey = Exclude<RpcContractKey, `jobs${string}` | "configPatch">;
type TypedRpcKeysMatchContract = [keyof TypedRpc] extends [TypedRpcContractKey]
    ? [TypedRpcContractKey] extends [keyof TypedRpc]
        ? true
        : false
    : false;

export const typedRpcKeysMatchContract: TypedRpcKeysMatchContract = true;

export function createTypedRpc(dispatch: RpcDispatch): TypedRpc {
    const contract = createContractDispatch(dispatch);

    return {
        // ── initialize (process-level bootstrap) ──
        initialize: (protocolVersion, clientCapabilities) =>
            contract.callProcess(RPC.initialize, {
                protocolVersion,
                clientCapabilities: clientCapabilities ?? {},
            }),

        // ── workspace ──
        workspaceList: () => contract.callProcess(RPC.workspaceList, undefined),

        // Workspace lifecycle methods route by cwd without requiring an existing runtime.
        workspaceEnsure: (cwd) => contract.call(RPC.workspaceEnsure, cwd, { cwd }),
        workspaceDispose: (cwd) => contract.call(RPC.workspaceDispose, cwd, { cwd }),

        // Association get/set are process-level: the key names a workspace OR a
        // channel, and a channel is not a routing key.
        workspaceAssociationsGet: (key) =>
            contract.callProcess(RPC.workspaceAssociationsGet, { key }),
        workspaceAssociationsSet: (key, roots) =>
            contract.callProcess(RPC.workspaceAssociationsSet, { key, roots }),
        // Resolve is workspace-scoped: the client asks "what applies to this
        // workspace" and the sidecar applies the scope fallback.
        workspaceAssociationsResolve: (workspace) =>
            contract.call(RPC.workspaceAssociationsResolve, workspace, { workspace }),

        // ── session ──
        sessionList: (workspace, opts) =>
            contract.call(RPC.sessionList, workspace, { workspace, ...(opts ?? {}) }),

        // sessionCreate: args go straight to params (workspace is inside args)
        sessionCreate: (args) => contract.call(RPC.sessionCreate, args.workspace, args),

        // sessionAttach: workspace + sessionId + optional opts spread
        sessionAttach: (workspace, sessionId, opts) =>
            contract.call(RPC.sessionAttach, workspace, {
                workspace,
                sessionId,
                ...(opts ?? {}),
            }),

        sessionDetach: (workspace, sessionId) =>
            contract.call(RPC.sessionDetach, workspace, { workspace, sessionId }),
        sessionDelete: (workspace, sessionId) =>
            contract.call(RPC.sessionDelete, workspace, { workspace, sessionId }),

        // sessionRename: workspace + sessionId + name.
        sessionRename: (workspace, sessionId, name) =>
            contract.call(RPC.sessionRename, workspace, {
                workspace,
                sessionId,
                name,
            }),
        sessionHistory: (workspace, sessionId) =>
            contract.call(RPC.sessionHistory, workspace, { workspace, sessionId }),
        sessionEventsGet: (workspace, sessionId, afterSeq) =>
            contract.call(RPC.sessionEventsGet, workspace, {
                workspace,
                sessionId,
                afterSeq,
            }),
        sessionSnapshotGet: (workspace, sessionId) =>
            contract.call(RPC.sessionSnapshotGet, workspace, {
                workspace,
                sessionId,
            }),
        // sessionTasksGet: returns the current task list snapshot; push fallback
        sessionTasksGet: (workspace, sessionId) =>
            contract.call(RPC.sessionTasksGet, workspace, { workspace, sessionId }),
        // sessionTaskHistoryGet: lazily fetches the full task items for a history list.
        sessionTaskHistoryGet: (workspace, sessionId, listId) =>
            contract.call(RPC.sessionTaskHistoryGet, workspace, { workspace, sessionId, listId }),
        // sessionPlanStateGet: returns the current plan-mode state snapshot; push fallback
        sessionPlanStateGet: (workspace, sessionId) =>
            contract.call(RPC.sessionPlanStateGet, workspace, { workspace, sessionId }),

        // sessionPrompt: workspace + sessionId + text + optional images + optional uiLocale
        sessionPrompt: (workspace, sessionId, text, images, uiLocale, model) =>
            contract.call(RPC.sessionPrompt, workspace, {
                workspace,
                sessionId,
                text,
                ...(images && images.length > 0 ? { images } : {}),
                ...(uiLocale ? { uiLocale } : {}),
                ...(model ? { model } : {}),
            }),

        // sessionSteer / sessionFollowUp: workspace + sessionId + text + optional images + optional uiLocale
        sessionSteer: (workspace, sessionId, text, images, uiLocale) =>
            contract.call(RPC.sessionSteer, workspace, {
                workspace,
                sessionId,
                text,
                ...(images && images.length > 0 ? { images } : {}),
                ...(uiLocale ? { uiLocale } : {}),
            }),
        sessionFollowUp: (workspace, sessionId, text, images, uiLocale) =>
            contract.call(RPC.sessionFollowUp, workspace, {
                workspace,
                sessionId,
                text,
                ...(images && images.length > 0 ? { images } : {}),
                ...(uiLocale ? { uiLocale } : {}),
            }),
        sessionCancelQueued: (workspace, sessionId, entryId) =>
            contract.call(RPC.sessionCancelQueued, workspace, {
                workspace,
                sessionId,
                entryId,
            }),

        // sessionSubmitAnswers: workspace + sessionId + toolCallId + answers + optional toolName
        sessionSubmitAnswers: (workspace, sessionId, toolCallId, answers, toolName) =>
            contract.call(RPC.sessionSubmitAnswers, workspace, {
                workspace,
                sessionId,
                toolCallId: asToolCallId(toolCallId),
                answers,
                ...(toolName ? { toolName } : {}),
            }),

        sessionAbort: (workspace, sessionId) =>
            contract.call(RPC.sessionAbort, workspace, { workspace, sessionId }),

        // subagentAbort: workspace + subSessionId (child session, not the parent's)
        subagentAbort: (workspace, subSessionId) =>
            contract.call(RPC.subagentAbort, workspace, {
                workspace,
                subSessionId,
            }),

        // sessionSetModel: workspace + sessionId + provider + modelId
        sessionSetModel: (workspace, sessionId, provider, modelId) =>
            contract.call(RPC.sessionSetModel, workspace, {
                workspace,
                sessionId,
                provider,
                modelId,
            }),

        // sessionListModels: workspace + optional provider
        sessionListModels: (workspace, provider) =>
            contract.call(RPC.sessionListModels, workspace, {
                workspace,
                provider,
            }),

        // providersList: workspace → built-in provider availability view
        providersList: (workspace) =>
            contract.call(RPC.providersList, workspace, {
                workspace,
            }),

        // providersRevealKey: workspace + providerId → plaintext key (or null)
        providersRevealKey: (workspace, providerId) =>
            contract.call(RPC.providersRevealKey, workspace, { workspace, providerId }),

        // sessionSetThinkingLevel: workspace + sessionId + level
        sessionSetThinkingLevel: (workspace, sessionId, level) =>
            contract.call(RPC.sessionSetThinkingLevel, workspace, {
                workspace,
                sessionId,
                level,
            }),

        // sessionCompact: workspace + sessionId + optional customInstructions
        sessionCompact: (workspace, sessionId, customInstructions) =>
            contract.call(RPC.sessionCompact, workspace, {
                workspace,
                sessionId,
                // Omit `customInstructions` from the RPC frame when absent, avoiding an undefined placeholder.
                ...(customInstructions ? { customInstructions } : {}),
            }),

        // sessionContextInfo: workspace + sessionId snapshot
        sessionContextInfo: (workspace, sessionId) =>
            contract.call(RPC.sessionContextInfo, workspace, { workspace, sessionId }),
        commandPermissionResolve: (workspace, params) =>
            contract.call(RPC.commandPermissionResolve, workspace, { workspace, ...params }),

        // ── settings(process-level)──
        settingsGet: () => contract.callProcess(RPC.settingsGet, undefined),
        settingsWrite: (params) => contract.callProcess(RPC.settingsWrite, params),

        // ── extensions(process-level)──
        extensionsStatus: () => contract.callProcess(RPC.extensionsStatus, undefined),
        channelsList: () => contract.callProcess(RPC.channelsList, undefined),
        channelsListConversations: (params) =>
            contract.callProcess(RPC.channelsListConversations, params ?? {}),
        channelsCreate: (params) => contract.callProcess(RPC.channelsCreate, params),
        channelsBind: (params) => contract.callProcess(RPC.channelsBind, params),
        channelsSubmitVerifyCode: (params) =>
            contract.callProcess(RPC.channelsSubmitVerifyCode, params),
        channelsUnbind: (params) => contract.callProcess(RPC.channelsUnbind, params),
        channelsRetry: (params) => contract.callProcess(RPC.channelsRetry, params),

        // ── imPolicy (process-level) ──
        imPolicyGet: (params) => contract.callProcess(RPC.imPolicyGet, params),
        imPolicySetChannelDefault: (params) =>
            contract.callProcess(RPC.imPolicySetChannelDefault, params),
        imPolicySetChatOverride: (params) =>
            contract.callProcess(RPC.imPolicySetChatOverride, params),
        imPolicyClearChatOverride: (params) =>
            contract.callProcess(RPC.imPolicyClearChatOverride, params),

        // ── provider (process-level, config-only helpers) ──
        providerListModels: (params) => contract.callProcess(RPC.providerListModels, params),
        providerTestConnection: (params) =>
            contract.callProcess(RPC.providerTestConnection, params),

        // ── tools ──
        toolsList: (workspace) => contract.call(RPC.toolsList, workspace, { workspace }),

        // ── agents ──
        agentsList: (workspace) => contract.call(RPC.agentsList, workspace, { workspace }),

        // agentsContent: workspace + agentType
        agentsContent: (workspace, agentType) =>
            contract.call(RPC.agentsContent, workspace, {
                workspace,
                agentType,
            }),

        agentsWrite: (workspace, params) =>
            contract.call(RPC.agentsWrite, workspace, {
                workspace,
                ...params,
            }),

        agentsDelete: (workspace, agentType) =>
            contract.call(RPC.agentsDelete, workspace, {
                workspace,
                agentType,
            }),

        // ── skills ──
        skillsList: (workspace) => contract.call(RPC.skillsList, workspace, { workspace }),

        // skillContent: workspace + filePath
        skillContent: (workspace, filePath) =>
            contract.call(RPC.skillContent, workspace, { workspace, filePath }),

        // ── checkpoints ──
        checkpointsList: (workspace, sessionId) =>
            contract.call(RPC.checkpointsList, workspace, {
                workspace,
                sessionId,
            }),

        checkpointsRestore: (workspace, checkpointId, sessionId) =>
            contract.call(RPC.checkpointsRestore, workspace, {
                workspace,
                checkpointId,
                sessionId,
            }),

        // ── memory ──
        memoryList: (workspace) => contract.call(RPC.memoryList, workspace, { workspace }),

        memoryWrite: (workspace, content, baseHash) =>
            contract.call(RPC.memoryWrite, workspace, {
                workspace,
                content,
                baseHash,
            }),

        memoryDeleteTopic: (workspace, id, expectedContent) =>
            contract.call(
                RPC.memoryDeleteTopic,
                workspace,
                expectedContent === undefined
                    ? { workspace, id }
                    : { workspace, id, expectedContent },
            ),

        memoryRestoreTopic: (workspace, id) =>
            contract.call(RPC.memoryRestoreTopic, workspace, { workspace, id }),
        memoryDreamRun: (workspace) =>
            contract.call(RPC.memoryDreamRun, workspace, {
                workspace,
            }),
        memoryDreamApply: (workspace, previewId) =>
            contract.call(RPC.memoryDreamApply, workspace, {
                workspace,
                previewId,
            }),
        memoryDreamDiscard: (workspace) =>
            contract.call(RPC.memoryDreamDiscard, workspace, { workspace }),
        memoryDreamUndo: (workspace, reportId) =>
            contract.call(RPC.memoryDreamUndo, workspace, {
                workspace,
                reportId,
            }),

        memoryUpsert: (workspace, action, params) =>
            contract.call(RPC.memoryUpsert, workspace, {
                workspace,
                action,
                id: params.id,
                name: params.name,
                content: params.content,
                type: params.type,
            }),

        // ── mcp (process-level) ──
        mcpListServers: (params) => contract.callProcess(RPC.mcpListServers, params ?? {}),
        mcpGetConfig: (id) => contract.callProcess(RPC.mcpGetConfig, { id }),
        mcpCreateConfig: (config) =>
            contract.callProcess(RPC.mcpCreateConfig, {
                config,
            }),
        mcpUpdateConfig: (id, patch) =>
            contract.callProcess(RPC.mcpUpdateConfig, {
                id,
                patch,
            }),
        mcpDeleteConfig: (id) => contract.callProcess(RPC.mcpDeleteConfig, { id }),
    };
}
