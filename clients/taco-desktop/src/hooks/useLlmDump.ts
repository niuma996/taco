/**
 * Groups `[taco:llm]` stderr lines into one entry per LLM call.
 * Entries remain in memory and are capped at 200, dropping the oldest first.
 * Each payload header starts the next entry.
 */

import { useCallback, useRef, useState } from "react";

const MAX_ENTRIES = 200;
const LLM_DUMP_PREFIX = "[taco:llm]";
const ENTRY_HEADER = "=== payload to model ===";

export interface LlmDumpEntry {
    /** One-based sequence number in push order, displayed in the header. */
    index: number;
    /** Wall-clock time when the entry was first observed, in epoch milliseconds. */
    timestamp: number;
    /** All stderr lines (prefix removed) for the LLM call, appended in arrival order. */
    lines: string[];
}

export interface UseLlmDump {
    entries: LlmDumpEntry[];
    push: (line: string) => void;
    clear: () => void;
}

export function useLlmDump(): UseLlmDump {
    const [entries, setEntries] = useState<LlmDumpEntry[]>([]);
    // Monotonic index held in a ref so functional setEntries updates can read it safely.
    const nextIndexRef = useRef(1);

    const push = useCallback((rawLine: string) => {
        // Guard: only consume prefixed lines (callers are expected to filter).
        if (!rawLine.startsWith(LLM_DUMP_PREFIX)) return;
        // Strip the prefix and one leading space, then unescape sidecar's line-fold.
        const line = rawLine
            .slice(LLM_DUMP_PREFIX.length)
            .replace(/^ /, "")
            .replace(/\\r/g, "\r")
            .replace(/\\n/g, "\n");

        const isHeader = line === ENTRY_HEADER;

        // Critical: use functional setEntries. All lines for one LLM call arrive in
        // the same synchronous batch, before React re-renders, so only `prev` sees
        // earlier lines in that batch; reading state/ref would lose body lines and
        // let a later header overwrite an earlier entry.
        setEntries((prev) => {
            if (isHeader) {
                const entry: LlmDumpEntry = {
                    index: nextIndexRef.current++,
                    timestamp: Date.now(),
                    lines: [],
                };
                const next = [...prev, entry];
                if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
                return next;
            }
            const last = prev[prev.length - 1];
            // Body line without a preceding header cannot be attributed; drop it.
            if (!last) return prev;
            // Immutable update: replace the last entry with a shallow copy plus the new line.
            const updated: LlmDumpEntry = { ...last, lines: [...last.lines, line] };
            return [...prev.slice(0, -1), updated];
        });
    }, []);

    const clear = useCallback(() => {
        nextIndexRef.current = 1;
        setEntries([]);
    }, []);

    return { entries, push, clear };
}
