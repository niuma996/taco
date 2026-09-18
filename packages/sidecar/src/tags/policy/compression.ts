import { tagWrap } from "../builder.ts";
import type { PinnedSegment } from "../types.ts";

/**
 * Build a text block with all pinned segments appended verbatim.
 * This is appended to the compression window tail, after the summary.
 */
export function buildPinnedTail(segments: ReadonlyArray<PinnedSegment>): string {
    if (segments.length === 0) return "";
    return [
        "\n\n",
        "=== PINNED (verbatim — do not paraphrase) ===",
        "",
        ...segments.map((s) => tagWrap(s.name as string, s.content, s.attrs)),
        "",
    ].join("\n");
}

/**
 * Additional-focus text for pi's summarization prompt. Lands at the end of
 * the seven-section template (`Additional focus: …`), not inside
 * `<conversation>` — the latter is serialized as session content.
 */
export function buildPinnedDirective(names: ReadonlyArray<string>): string | null {
    if (names.length === 0) return null;
    const listed = names.join(", ");
    return (
        `Pinned tag bodies (${listed}) are appended verbatim after this summary. ` +
        "Name those tags if they matter; do not quote, paraphrase, or summarize their contents."
    );
}

/**
 * Combine a caller-supplied `customInstructions` string with the pin
 * directive. Either side may be absent; undefined means pi skips
 * `Additional focus` entirely.
 */
export function mergeCompactionInstructions(
    customInstructions: string | undefined,
    pinnedNames: ReadonlyArray<string>,
): string | undefined {
    const pin = buildPinnedDirective(pinnedNames);
    if (customInstructions && pin) return `${customInstructions}\n\n${pin}`;
    return customInstructions ?? pin ?? undefined;
}
