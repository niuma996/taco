/**
 * Content-aware context hook throttling. Skips injection when the proposed messages
 * haven't changed since the last call (hash match = skip, hash diff = inject).
 * Tags with changing content every turn (e.g. `<env>` with live timestamp) will
 * never be throttled — intended.
 */

import { createHash } from "node:crypto";
import type { ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";

export interface ThrottleOptions {
    /**
     * Maximum number of consecutive times we'll skip before forcing a re-inject,
     * even if the content hasn't changed. Prevents content from being
     * permanently absent across an extremely long session. Default: Infinity.
     */
    maxConsecutiveSkips?: number;
}

export function throttleByContent(
    hook: (event: ContextEvent) => ContextResult | undefined | Promise<ContextResult | undefined>,
    options?: ThrottleOptions,
): (event: ContextEvent) => Promise<ContextResult | undefined> {
    const maxSkips = options?.maxConsecutiveSkips ?? Number.POSITIVE_INFINITY;
    let lastContentHash: string | null = null;
    let consecutiveSkips = 0;

    function hashMessages(messages: ContextResult["messages"]): string {
        const text = messages
            .map((m) => {
                const content = (m as { content?: unknown }).content;
                if (typeof content === "string") return content;
                if (Array.isArray(content))
                    return (content as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
                return "";
            })
            .join("");
        return createHash("sha256").update(text).digest("hex");
    }

    return async (event: ContextEvent): Promise<ContextResult | undefined> => {
        const result = await hook(event);
        if (!result || result.messages.length === 0) {
            // Inner hook chose no-op — don't update state, just pass through.
            return undefined;
        }

        const hash = hashMessages(result.messages);
        if (hash === lastContentHash && consecutiveSkips < maxSkips) {
            consecutiveSkips++;
            return undefined;
        }

        lastContentHash = hash;
        consecutiveSkips = 0;
        return result;
    };
}
