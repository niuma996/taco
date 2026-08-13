/**
 * Tag system public surface.
 *
 * Keep this small. Only what `AttachedSession` (and similar upper-layer
 * callers) actually consume belongs here. Internal helpers stay un-exported.
 * Current consumers: `buildDropPolicyContextHook` for the AgentHarness
 * `context` hook. TUI visibility helpers are exported so future TUI code
 * can use them without re-importing the policy files.
 */

export {
    type AskUserRehydrateEntry,
    type ParsedAskUserContext,
    parseAskUserContext,
    rehydrateAskUserDetails,
} from "./askUserRehydrate.ts";
export { tagWrap } from "./builder.ts";
export {
    buildCompactionReminderHook,
    type CompactionReminderHandle,
} from "./compactionReminder.ts";
export {
    applyTuiVisibility,
    applyTuiVisibilityToContent,
    buildDropPolicyContextHook,
    buildInstructionsContextHook,
    buildStripThinkingContextHook,
} from "./convertToLlm.ts";
export { buildEnvContextHook } from "./envContext.ts";
export type {
    EntityItem,
    ExtractFactsOptions,
    FactItem,
    FactSet,
} from "./factExtractor.ts";
// Fact extraction is also called from the pin-aware compact hook; consumers
// that only want the dedup helper can import `mergeFacts` directly.
export {
    EMPTY_FACTS,
    extractFacts,
    mergeFacts,
    serializeMessagesForFacts,
} from "./factExtractor.ts";
export { findBalancedTagsSkippingFences } from "./fenceAware.ts";
export {
    buildImChannelContextHook,
    type ImChannelContext,
} from "./imChannelContext.ts";
export { buildPlanModeContextHook } from "./planMode.ts";
export { stripDropTagsFromMessages } from "./policy/dropPolicy.ts";
export type { ExtendedFileOps } from "./policy/extendedFileOps.ts";
export { extractExtendedFileOps } from "./policy/extendedFileOps.ts";
export type {
    PinAwareCompactHookOptions,
    PinAwareCompactionDetails,
} from "./policy/pinAwareCompact.ts";
// Pin-aware compression hook — sole consumer is `runtime/hookWiring.ts`,
// which registers it as a trusted `session_before_compact` hook.
export { buildPinAwareCompactHook } from "./policy/pinAwareCompact.ts";
export { isContentEmptyAfterVisibility } from "./policy/visibility.ts";
export { tagRegistry } from "./registry.ts";
export { buildReplyLanguageContextHook } from "./replyLanguage.ts";
export type {
    BalancedTag,
    CompressionPolicy,
    ParserKind,
    PinnedSegment,
    TagName,
    TagScope,
    TagSpec,
} from "./types.ts";
