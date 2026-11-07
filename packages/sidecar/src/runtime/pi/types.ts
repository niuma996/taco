/**
 * Single re-export point for upstream pi type aliases consumed by the sidecar.
 *
 * Upstream renames should land here, so the churn is one edit in this file
 * plus a tsc sweep — but the barrel is not complete yet: a handful of
 * importers still reach `@earendil-works/pi-ai` directly.
 *
 * Scope: type aliases only. Runtime values (factories, provider handles,
 * tagged error classes, lazy API loaders) keep their direct imports so the
 * tree-shaking and lazy-loading contracts of those subpaths are preserved.
 * See `runtime/pi/values.ts` for cross-domain value re-exports and
 * `runtime/pi/node.ts` for types that live under `pi-agent-core/node`.
 */

export type {
    Api,
    AssistantMessage,
    Context as ApiContext,
    Credential,
    CredentialInfo,
    CredentialStore,
    ImageContent,
    Model,
    Models,
    MutableModels,
    Provider,
    RetryPolicy,
    TextContent,
    // pi-ai's request-level thinking level — six values, without "off".
    // pi-harness's own `ThinkingLevel` (below) carries the "off" that the
    // protocol surface uses.
    ThinkingLevel as ApiThinkingLevel,
    Usage,
} from "@earendil-works/pi-ai";
export type {
    AgentHarness,
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    AgentHarnessTool,
    AgentHarnessToolUpdateCallback,
    AgentLane,
    AgentMessage,
    AgentToolResult,
    CompactionPreparation,
    CompactionSettings,
    CompactResult,
    Context,
    Entry,
    ExecutionToolContext,
    HarnessEvent,
    JsonlSessionMetadata,
    JsonlSessionRepo,
    JsonValue,
    OpenOperation,
    PromptTemplate,
    Session,
    Skill,
    ThinkingLevel,
} from "@taco-ai/pi-harness";
