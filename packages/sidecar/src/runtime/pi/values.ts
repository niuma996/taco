/**
 * Re-export point for cross-domain pi value symbols.
 *
 * Sidecar code imports pi values (factories, leaf helpers, tagged errors) from
 * here instead of `@earendil-works/pi-*`, so a pi rename stays in this one file
 * plus a tsc sweep. Provider factories, lazy API loaders, faux test providers
 * and the compat surface keep their direct imports — those paths are part of
 * the tree-shaking contract with upstream.
 *
 * `BACKGROUND_CONTEXT` and `LaneBusy` are re-exported for tests; production
 * code goes through the wrapper modules instead.
 */

export {
    clampThinkingLevel,
    createProvider,
    envApiKeyAuth,
    normalizeContext,
} from "@earendil-works/pi-ai";
export { estimateContextTokens as estimateApiContextTokens } from "@earendil-works/pi-ai/utils/estimate";
export {
    AgentHarness,
    BACKGROUND_CONTEXT,
    CompactionError,
    compact,
    createBranchSummaryMessage,
    createCompactionSummaryMessage,
    createEditTool,
    createReadTool,
    createWriteTool,
    DEFAULT_COMPACTION_SETTINGS,
    estimateContextTokens,
    getOrThrow,
    InMemoryTelemetryContext,
    JsonlSessionRepo,
    LaneBusy,
    laneConfig,
    loadSourcedSkills,
    MemorySessionRepo,
    NoActiveOperation,
    NothingToCompact,
    NothingToResume,
    prepareCompaction,
    Result,
    setDefaultStreamFn,
    shouldCompact,
    uuidv7,
    value,
    withAbortSignal,
    withTelemetryContext,
} from "@taco-ai/pi-harness";
