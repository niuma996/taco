/**
 * RPC method-name constants table.
 *
 * Single source of truth: server-side handlers live in
 * packages/sidecar/src/server/methods.ts. Kept as `as const` (not an enum) to
 * stay type-compatible with the string `RpcRequest.method` field.
 */

export const RPC = {
    // Process-level bootstrap. First client → server request after sidecar.hello.
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
    commandPermissionResolve: "command_permission.resolve",
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
