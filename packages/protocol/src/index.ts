/**
 * @taco-ai/protocol — Taco sidecar protocol contract.
 *
 * Types and constants only; no runtime dependencies (both server and client import it).
 * Session message shapes (`AgentMessage` / `ThinkingLevel`) are protocol-native DTOs
 * with zero external dependencies.
 *
 * Split by domain into frames / session / config / push / memory / tools / messages;
 * this file re-exports them — consumers still write `from "@taco-ai/protocol"`, and
 * the internal dependency graph converges at file granularity.
 */

// channels.* RPC types — IM channel listing / binding.
export type {
    ChannelInstanceConfig,
    ChannelState,
    ChannelStatusChangedParams,
    ChannelStatusEntry,
    ChannelsBindCreds,
    ChannelsBindParams,
    ChannelsBindResult,
    ChannelsCreateParams,
    ChannelsCreateResult,
    ChannelsListConversationsParams,
    ChannelsListConversationsResult,
    ChannelsListParams,
    ChannelsListResult,
    ChannelsSubmitVerifyCodeParams,
    ChannelsSubmitVerifyCodeResult,
    ChannelsUnbindParams,
    ChannelsUnbindResult,
    ChannelTypeEntry,
    ImConversationEntry,
} from "./channels.js";
export { IM_CWD_PREFIX, makeImCwd, parseImCwd } from "./channels.js";
// Checkpoint RPC types.
export type {
    CheckpointEntry,
    CheckpointFileEntry,
    CheckpointsListParams,
    CheckpointsListResult,
    CheckpointsRestoreParams,
    CheckpointsRestoreResult,
} from "./checkpoints.js";
// taco.json + settings + custom providers + commands + extensions.
export type {
    ChannelInstanceConfigView,
    CommandEvaluation,
    CommandPermissionConfig,
    CommandPermissionDecision,
    CommandPermissionMode,
    CommandPermissionRequest,
    CommandPermissionResolveParams,
    CommandPermissionResolveResult,
    CommandPermissionRule,
    CommandPermissionScope,
    CommandRisk,
    CompactionConfig,
    CustomModelEntry,
    CustomProviderApi,
    CustomProviderConfig,
    ExtensionPermission,
    ExtensionSource,
    ExtensionStatusEntry,
    ExtensionsStatusParams,
    ExtensionsStatusResult,
    InstructionsConfig,
    MaskedKey,
    McpCreateConfigParams,
    McpDeleteConfigParams,
    McpDeleteConfigResult,
    McpGetConfigParams,
    McpGetConfigResult,
    McpListServersResult,
    McpMutateConfigResult,
    McpServerConfig,
    McpServerConfigView,
    McpServerView,
    McpTransportKind,
    McpUpdateConfigParams,
    SettingsGetParams,
    SettingsGetResult,
    SettingsWriteParams,
    SettingsWriteResult,
    TacoGlobalConfigShape,
    TacoGlobalConfigView,
} from "./config.js";
export {
    COMMAND_PERMISSION_MODES,
    COMPACTION_THRESHOLD_MAX,
    COMPACTION_THRESHOLD_MIN,
    CUSTOM_PROVIDER_PREFIX,
    DEFAULT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_THRESHOLD,
} from "./config.js";
export type { ErrorCode } from "./errors.js";
// Error code constants — wire-stable strings for RpcResponse.error.code.
export { ErrorCodes } from "./errors.js";
// Wire frames — routing keys, request/response/push, hello + capabilities.
export type {
    ClientCapabilities,
    CompactionFailureReason,
    ImageInput,
    InitializeParams,
    InitializeResult,
    RpcRequest,
    RpcResponse,
    ServerPush,
    SessionId,
    SidecarCapabilities,
    SupportedLocale,
    WorkspaceId,
} from "./frames.js";
export {
    CURRENT_SESSION_FORMAT_VERSION,
    isCompatibleClientProtocol,
    isCompatibleSidecarProtocol,
    SIDECAR_PROTOCOL_VERSION,
} from "./frames.js";
// imPolicy.* RPC types — IM workspace policy admin surface.
export type {
    ImCommandPolicy,
    ImPolicyChatOverrideEntry,
    ImPolicyClearChatOverrideParams,
    ImPolicyGetParams,
    ImPolicyGetResult,
    ImPolicySetChannelDefaultParams,
    ImPolicySetChatOverrideParams,
    ImPolicyWriteResult,
    ImRoute,
    ImToolPolicy,
    ImWorkspacePolicy,
    ImWorkspacePolicyDocument,
    ImWorkspacePolicyPatch,
} from "./imPolicy.js";
// Memory RPC types.
export type {
    MemoryDeleteTopicParams,
    MemoryDeleteTopicResult,
    MemoryListParams,
    MemoryListResult,
    MemoryTopicEntry,
    MemoryUpsertParams,
    MemoryUpsertResult,
    MemoryWriteParams,
    MemoryWriteResult,
} from "./memory.js";
export { MEMORY_CONTENT_MAX_CHARS } from "./memory.js";
// Session message DTOs — protocol-native.
export type {
    AgentMessage,
    AssistantMessage,
    ImageBlock,
    ProtocolContentBlock,
    TextBlock,
    ThinkingBlock,
    ThinkingLevel,
    ToolCallBlock,
    ToolResultMessage,
    Usage,
    UserMessage,
} from "./messages.js";
// Push methods + payload types.
export type {
    AttachedParams,
    CommandPermissionRequestedParams,
    ConversationsChangedParams,
    DetachedParams,
    ErrorParams,
    EventParams,
    ImPolicyChangedParams,
    ImToolsEnabledParams,
    ImWorkspacesInvalidatedParams,
    ModelsChangedParams,
    PlanStateUpdatedParams,
    PushMethodName,
    PushParams,
    PushParamsByMethod,
    SessionCompactionFinishedParams,
    SessionCompactionStartedParams,
    SessionDeletedParams,
    SubagentSpawnedParams,
    TaskItem,
    TaskListMeta,
    TasksUpdatedParams,
    ToolCallEndParams,
    ToolCallStartParams,
    ToolCallUpdateParams,
} from "./push.js";
export { PushMethods } from "./push.js";
// RPC param schemas (typebox) — wire validators consumed by registerMethod.
export * from "./schemas/index.js";
// session.* RPC types (lifecycle / turn / runtime / snapshot / read).
export type {
    AbortParams,
    AbortResult,
    AttachParams,
    CreateSessionParams,
    CreateSessionResult,
    DeleteSessionParams,
    ListModelsParams,
    PromptParams,
    PromptResult,
    ProviderListModelsParams,
    ProviderListModelsResult,
    ProvidersListParams,
    ProvidersListResult,
    ProviderView,
    RenameSessionParams,
    SessionCompactParams,
    SessionCompactResult,
    SessionContextInfoParams,
    SessionContextInfoResult,
    SessionEventsGetParams,
    SessionEventsGetResult,
    SessionHistory,
    SessionHistoryEntry,
    SessionListCursor,
    SessionListEntry,
    SessionListParams,
    SessionListResult,
    SessionMeta,
    SessionSetThinkingLevelParams,
    SessionSnapshot,
    SessionSnapshotGetParams,
    SetModelParams,
    SteerParams,
} from "./session.js";
export { SESSION_LIST_DEFAULT_LIMIT, SESSION_LIST_MAX_LIMIT } from "./session.js";
// Tools / skills / agents / askUser / subagent RPC types.
export type {
    AgentContinueToolDetails,
    AgentEntry,
    AgentsContentParams,
    AgentsContentResult,
    AgentsListParams,
    AgentsListResult,
    AgentToolDetails,
    AskUserParams,
    AskUserQuestion,
    AskUserToolDetails,
    QuestionOption,
    SkillContentParams,
    SkillContentResult,
    SkillDiagnosticCode,
    SkillDiagnosticEntry,
    SkillEntry,
    SkillsListParams,
    SkillsListResult,
    SubagentSpawnedPayload,
    SubmitAnswersParams,
    ToolEntry,
    ToolsListParams,
    ToolsListResult,
} from "./tools.js";
