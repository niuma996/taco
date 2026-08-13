/**
 * Message content traversal utilities.
 *
 * `mapMessageText` applies a string transformation to all text content in a
 * message, regardless of whether content is a plain string or a block array.
 */

interface MaybeTextBlock {
    type?: unknown;
    text?: unknown;
}

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
    if (!b || typeof b !== "object") return false;
    const t = (b as MaybeTextBlock).type;
    const x = (b as MaybeTextBlock).text;
    return t === "text" && typeof x === "string";
}

/**
 * Apply `transform` to all text content in `msg`.
 * Works whether `msg.content` is a string or a block array.
 * Returns the original message if nothing changed (structural sharing).
 */
export function mapMessageText<M extends { content: unknown }>(
    msg: M,
    transform: (s: string) => string,
): M {
    const c = msg.content;
    if (typeof c === "string") {
        const out = transform(c);
        if (out === c) return msg;
        return { ...msg, content: out };
    }
    if (Array.isArray(c) && c.length > 0) {
        let changed = false;
        const next = c.map((b) => {
            if (isTextBlock(b)) {
                const out = transform(b.text);
                if (out !== b.text) {
                    changed = true;
                    return { ...b, text: out };
                }
            }
            return b;
        });
        return changed ? ({ ...msg, content: next } as M) : msg;
    }
    return msg;
}
