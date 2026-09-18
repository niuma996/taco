/**
 * Re-export point for cross-domain pi value symbols.
 *
 * Mirrors `types.ts` for runtime values: sidecar code that wants a pi value
 * (factory function, leaf helper, tagged error class) imports it from here
 * instead of from `@earendil-works/pi-*` directly. When pi renames or
 * reshapes a value symbol, the churn stays in this one file plus a tsc sweep.
 *
 * Scope: every non-lazy, non-provider value we import from
 * `@earendil-works/pi-agent-core` or `@earendil-works/pi-ai`. Provider
 * factories (`pi-ai/providers/*`), lazy API loaders (`pi-ai/api/*.lazy`),
 * faux test providers (`pi-ai/providers/faux`), and the compat surface
 * (`pi-ai/compat`) are deliberately excluded — those keep their direct
 * imports because their import path itself is part of the tree-shaking
 * contract with upstream.
 *
 * Not every export here is meant for production code. A few exist because
 * tests need the raw pi value while production deliberately goes through a
 * wrapper:
 *
 *   - `BACKGROUND_CONTEXT` — production reads `harnessContext` from
 *     `lib/harnessContext.ts`, which owns the choice of root context.
 *   - `LaneBusy` — production classifies harness failures through
 *     `runtime/harness/harnessErrors.ts` rather than matching the tag directly.
 *
 * If you are writing production code and the symbol you want is one of
 * those, use the wrapper. The re-export is here so tests can construct and
 * assert on the upstream value without punching through the boundary rule.
 */
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
    JsonlSessionRepo,
    LaneBusy,
    laneConfig,
    loadSourcedSkills,
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
} from "@earendil-works/pi-agent-core";

export { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
