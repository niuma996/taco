/**
 * Single re-export point for upstream pi type aliases consumed by the sidecar.
 *
 * Why this exists: every file that needs a pi type used to import it directly
 * from `@earendil-works/pi-agent-core` or `@earendil-works/pi-ai`. When the
 * upstream package renames a type (e.g. `ContextEvent` → `Entry` in 0.85), the
 * churn scatters across every importer. Routing types through this barrel
 * keeps the rename cost to one edit here plus a tsc sweep.
 *
 * Scope: type aliases only. Runtime values (factories, provider handles,
 * tagged error classes, lazy API loaders) keep their direct imports so the
 * tree-shaking and lazy-loading contracts of those subpaths are preserved.
 * See `runtime/pi/values.ts` for cross-domain value re-exports and
 * `runtime/pi/node.ts` for types that live under `pi-agent-core/node`.
 */
export type {
    AgentHarness,
    AgentHarnessResources,
    AgentHarnessStreamOptions,
    AgentHarnessTool,
    AgentLane,
    AgentMessage,
    AgentToolResult,
    CompactionPreparation,
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
} from "@earendil-works/pi-agent-core";

export type {
    Api,
    Credential,
    CredentialInfo,
    CredentialStore,
    ImageContent,
    Model,
    Models,
    MutableModels,
    Provider,
    TextContent,
    Usage,
} from "@earendil-works/pi-ai";
