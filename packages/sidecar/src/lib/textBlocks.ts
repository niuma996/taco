/**
 * Text payload of each `text` content block, in order. Non-text blocks
 * (images, tool calls) are skipped so callers can `join` uniformly.
 */
export function textBlocks(
    blocks: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string[] {
    const out: string[] = [];
    for (const block of blocks) {
        if (block.type === "text" && block.text !== undefined) out.push(block.text);
    }
    return out;
}
