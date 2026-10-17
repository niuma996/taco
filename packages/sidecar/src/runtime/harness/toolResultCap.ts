/**
 * Size cap on every tool result before it is committed to the session.
 *
 * A single oversized result cannot be rescued by compaction: pi never splits
 * a run of tool results, so it lands whole in the retained tail, and the next
 * request overflows with nothing left to cut. Per-tool limits miss MCP tools
 * and anything added later, so the backstop sits at the harness boundary.
 *
 * Keeps head and tail — build and test output put the failure at the end,
 * search output puts the best matches at the start.
 */

import type { ToolResultEvent, ToolResultPatch } from "../../extensions/types.ts";

/** ~25k tokens at the usual 2-4 chars/token — a few of these still fit a 200k window. */
export const TOOL_RESULT_MAX_CHARS = 100_000;

const HEAD_SHARE = 0.4;

function clip(text: string, max: number): string {
    const head = Math.floor(max * HEAD_SHARE);
    const tail = max - head;
    const omitted = text.length - head - tail;
    return (
        `${text.slice(0, head)}\n\n… [${omitted} chars omitted: tool output exceeded ` +
        `${max} chars. Narrow the command or query to see the middle.]\n\n${text.slice(-tail)}`
    );
}

/** Text parts at or under this size are never clipped, so a short header survives a huge body. */
const SMALL_PART_CHARS = 1_000;

/**
 * Clip text parts so their combined length stays within `max`. Small parts are
 * kept whole and the large ones share what is left in proportion to their size.
 * Image parts pass through untouched; the provider sizes them, not char count.
 */
export function capToolResult(
    event: Pick<ToolResultEvent, "content">,
    max: number = TOOL_RESULT_MAX_CHARS,
): ToolResultPatch | undefined {
    let total = 0;
    let small = 0;
    for (const part of event.content) {
        if (part.type !== "text") continue;
        total += part.text.length;
        if (part.text.length <= SMALL_PART_CHARS) small += part.text.length;
    }
    if (total <= max) return undefined;
    const large = total - small;
    const budget = Math.max(SMALL_PART_CHARS, max - small);
    return {
        content: event.content.map((part) => {
            if (part.type !== "text" || part.text.length <= SMALL_PART_CHARS) return part;
            const share = Math.floor((budget * part.text.length) / large);
            return part.text.length <= share ? part : { ...part, text: clip(part.text, share) };
        }),
    };
}
