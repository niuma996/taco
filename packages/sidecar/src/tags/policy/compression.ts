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
 * Build a directive telling the summary LLM which tag bodies are pinned verbatim.
 * Injected as a user message before the summarization LLM call.
 */
export function buildPinnedDirective(names: ReadonlyArray<string>): string | null {
    if (names.length === 0) return null;
    return `The following tag bodies are pinned verbatim and will be appended to the window before the summary — do NOT quote or paraphrase their bodies: ${names.join(", ")}.`;
}
