/**
 * Translate taco's two user-facing knobs (`enabled` + `threshold`) into pi's
 * three-field `CompactionSettings`.
 *
 * pi couples two unrelated budgets into `reserveTokens`: `shouldCompact` reads
 * it as trigger headroom (`tokens > ctx - reserveTokens`), while
 * `generateSummaryWithRequest` reads it as the summary output budget
 * (`maxTokens = 0.8 * reserveTokens`, with no floor of its own). A single
 * number cannot express both "trigger at 10%" and "leave the summary ~3k
 * tokens", so the two are split by path:
 *
 *   - `reserveTokens` is sized for summary quality, and is additionally capped
 *     so pi's mid-run overflow net (every turn boundary) can never fire
 *     *earlier* than the user's threshold.
 *   - the user's threshold drives `CompactionController.maybeCompact` through
 *     `triggerTokens` directly, and drives how much is retained through
 *     `keepRecentTokens`.
 *
 * One shared instance feeds all three compaction paths (pi's turn-boundary
 * overflow check, taco's `run_end` check, and the pin-aware hook), which is why
 * this derivation lives in its own module rather than inside the controller.
 */

import type { CompactionSettings } from "../pi/types.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../pi/values.ts";

/** Smallest summary output budget worth generating (0.8 x 4096 ~ 3.2k tokens). */
const MIN_RESERVE_TOKENS = 4096;

/** Floor for retained recent context, itself bounded by KEEP_CEILING_RATIO. */
const MIN_KEEP_RECENT_TOKENS = 4096;

/** Retain half the allowed budget so the next turn has room before re-triggering. */
const KEEP_RATIO = 0.5;

/** Retaining more than this share of the trigger point cannot compact anything. */
const KEEP_CEILING_RATIO = 0.8;

/** Context size at which auto-compaction fires — the user's threshold, verbatim. */
export function triggerTokens(contextWindow: number, threshold: number): number {
    return Math.floor(contextWindow * threshold);
}

/**
 * Derive the `CompactionSettings` for one model window. Pure — callers
 * re-derive on attach and whenever the threshold or model changes, rather than
 * caching a snapshot that would pin a stale window.
 */
export function deriveCompactionSettings(
    enabled: boolean,
    threshold: number,
    contextWindow: number,
): CompactionSettings {
    // No usable model window yet: keep pi's defaults rather than inventing
    // numbers. `enabled` still applies — it is a user toggle, not a window
    // property, and must reach pi's turn-boundary check either way.
    if (contextWindow <= 0) {
        return { ...DEFAULT_COMPACTION_SETTINGS, enabled };
    }

    const trigger = triggerTokens(contextWindow, threshold);

    // `min` against pi's default caps the summary budget so a high threshold
    // cannot inflate it. The resulting overflow net (`ctx - reserve`) fires at
    // or after the user's threshold whenever `ctx * (1 - threshold)` is at
    // least MIN_RESERVE_TOKENS; below that, the inner `max` binds and the net
    // fires slightly early — the deliberate cost of never letting the summary
    // budget collapse on a small window.
    const reserveTokens = Math.min(
        DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        Math.max(MIN_RESERVE_TOKENS, Math.floor(contextWindow * (1 - threshold))),
    );

    // The ceiling beats the floor on tiny windows, where a 4096 floor would
    // exceed the trigger point and turn every compaction into a no-op
    // (`prepareCompaction` cuts nothing, so `NothingToCompact`).
    const keepCeiling = Math.floor(trigger * KEEP_CEILING_RATIO);
    const keepRecentTokens = Math.max(
        1,
        Math.floor(trigger * KEEP_RATIO),
        Math.min(MIN_KEEP_RECENT_TOKENS, keepCeiling),
    );

    return { enabled, reserveTokens, keepRecentTokens };
}
