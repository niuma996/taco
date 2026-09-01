/**
 * RPC method-name constants table.
 *
 * Single source of truth: server-side handlers live in
 * packages/sidecar/src/server/methods.ts. Kept as `as const` (not an enum) to
 * stay type-compatible with the string `RpcRequest.method` field.
 */

export const RPC = {
    // Process-level bootstrap. First client → server request on a connection.
    initialize: "initialize",
    // workspace.*
    workspaceList: "workspace.list",
    workspaceEnsure: "workspace.ensure",
    workspaceDispose: "workspace.dispose",
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
    sessionAbort: "session.abort",
    commandPermissionResolve: "commandPermission.resolve",
    sessionSetModel: "session.setModel",
    sessionListModels: "session.listModels",
    /** List the availability view of built-in providers (configured + models) for the Model settings UI. */
    providersList: "providers.list",
    sessionSetThinkingLevel: "session.setThinkingLevel",
    sessionCompact: "session.compact",
    sessionContextInfo: "session.contextInfo",
    /** Submit askUser answers — sidecar injects <ask_user_context> into the user message; clients don't see the wire format. */
    sessionSubmitAnswers: "session.submitAnswers",
    /** Pull model ids from the user's custom provider's /v1/models endpoint during CustomProviderForm edit. */
    providerListModels: "provider.listModels",
    // settings.*
    settingsGet: "settings.get",
    settingsWrite: "settings.write",
    // extensions.*
    extensionsStatus: "extensions.status",
    // channels.* — IM channel listing / binding.
    channelsList: "channels.list",
    channelsListConversations: "channels.listConversations",
    channelsCreate: "channels.create",
    channelsBind: "channels.bind",
    channelsSubmitVerifyCode: "channels.submitVerifyCode",
    channelsUnbind: "channels.unbind",
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
    // mcp.* — MCP server discovery and health status.
    mcpListServers: "mcp.listServers",
    mcpGetConfig: "mcp.getConfig",
    mcpCreateConfig: "mcp.createConfig",
    mcpUpdateConfig: "mcp.updateConfig",
    mcpDeleteConfig: "mcp.deleteConfig",
} as const;

export type RpcMethodName = (typeof RPC)[keyof typeof RPC];

/**
 * Methods that must answer promptly or not at all.
 *
 * These are pure reads: the server answers from disk or memory without waiting
 * on a model, a subprocess, or the network. A daemon that has accepted the
 * connection and finished the handshake but cannot answer one of these within
 * seconds is not "busy", it is broken — and the caller is better served by an
 * error it can retry or surface than by a promise that never settles.
 *
 * The distinction matters because the default RPC ceiling is deliberately huge
 * (a `session.prompt` can legitimately stream for many minutes). Applying that
 * ceiling to a metadata read is what let a wedged daemon leave the desktop's
 * sidebar empty with nothing to catch: the await simply never returned.
 *
 * Deliberately NOT in this set:
 *   - session.prompt / steer / compact / submitAnswers — model-bound, unbounded
 *     by nature.
 *   - provider.listModels — reaches out to a user-configured HTTP endpoint.
 *   - channels.* bind/verify — waits on a human completing a flow.
 *   - checkpoints.restore, memory.write, *.create/update/delete — mutations,
 *     where a spurious timeout could leave the caller unsure whether the write
 *     landed. A slow mutation is a lesser evil than an ambiguous one.
 */
export const FAST_RPC_METHODS: ReadonlySet<string> = new Set<string>([
    RPC.workspaceList,
    RPC.sessionList,
    RPC.sessionHistory,
    RPC.sessionEventsGet,
    RPC.sessionSnapshotGet,
    RPC.sessionTasksGet,
    RPC.sessionTaskHistoryGet,
    RPC.sessionPlanStateGet,
    RPC.sessionListModels,
    RPC.sessionContextInfo,
    RPC.providersList,
    RPC.settingsGet,
    RPC.extensionsStatus,
    RPC.channelsList,
    RPC.channelsListConversations,
    RPC.imPolicyGet,
    RPC.toolsList,
    RPC.agentsList,
    RPC.agentsContent,
    RPC.skillsList,
    RPC.skillContent,
    RPC.checkpointsList,
    RPC.memoryList,
    RPC.mcpListServers,
    RPC.mcpGetConfig,
]);

/**
 * Ceiling for `FAST_RPC_METHODS`. 15s is far above any healthy local read
 * (measured: a 31MB / 262-file session store answers `session.list` in
 * milliseconds) while still leaving room for a loaded machine mid-cold-start,
 * where the daemon may be competing with the app's own startup for CPU.
 */
export const FAST_RPC_TIMEOUT_MS = 15_000;
