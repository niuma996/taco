import type { SubagentRuntime } from "../../../agents/types.ts";

/** Preserve the standard-engine fallback for persisted and legacy runtime values. */
export function normalizeSubagentRuntime(runtime?: string): SubagentRuntime {
    return runtime === "claude-code" || runtime === "codex" ? runtime : "standard";
}

export function sameSubagentRuntime(left?: string, right?: string): boolean {
    return normalizeSubagentRuntime(left) === normalizeSubagentRuntime(right);
}
