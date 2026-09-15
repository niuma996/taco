/**
 * Subagent list derivation — the right-side panel's list is derived from the
 * session's message stream, never stored. Switching sessions or workspaces
 * therefore needs no cleanup: the list follows `ws.messages` automatically.
 *
 * Derivation is per-item fault tolerant on purpose. A single malformed tool
 * call must not blank out the whole panel, so every item is parsed inside a
 * try/catch and bad ones are skipped.
 */

import type { ToolCallStatus, UiMessage, UiToolCall } from "./chatUtils";

/**
 * `detached` is the fourth state this module adds on top of ToolCallStatus:
 * an agent call whose toolResult never landed (sidecar killed mid-run) has no
 * persisted subSessionId, so its child session can no longer be opened.
 */
export type SubagentStatus = "running" | "ok" | "error" | "detached";

export interface SubagentEntry {
    /** null means detached — no child session to bind. */
    subSessionId: string | null;
    agentType: string;
    description: string;
    prompt: string;
    status: SubagentStatus;
    /** Tool call that first introduced this subagent; used as a stable React key. */
    firstToolCallId: string;
}

/** Default right-panel width in px; matches the middle of --pane-width's clamp. */
export const RIGHT_PANEL_DEFAULT_WIDTH = 280;

const RIGHT_PANEL_MIN_WIDTH = 220;
const RIGHT_PANEL_MAX_WIDTH = 640;
const FALLBACK_VIEWPORT_WIDTH = 1440;

const AGENT_TOOL_NAMES = new Set(["agent", "agentContinue"]);

const TOOL_CALL_STATUSES = new Set<ToolCallStatus>(["running", "ok", "error"]);

function readString(source: unknown, key: string): string {
    if (typeof source !== "object" || source === null) return "";
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
}

/**
 * Parse one tool call into an entry, or null when it is not a subagent call.
 * Throwing is left to the caller's try/catch — this keeps the happy path flat.
 */
function entryFromTool(tool: UiToolCall): SubagentEntry | null {
    if (!AGENT_TOOL_NAMES.has(tool.name)) return null;
    // A call without a real id or status is malformed — throw so the caller's
    // try/catch skips it instead of emitting a bogus panel row.
    if (typeof tool.id !== "string") throw new Error("agent tool call missing id");
    if (!TOOL_CALL_STATUSES.has(tool.status)) throw new Error("agent tool call missing status");

    const subSessionId = readString(tool.details, "subSessionId") || null;
    const agentType =
        readString(tool.details, "agentType") || readString(tool.args, "subagent_type") || "agent";

    return {
        subSessionId,
        agentType,
        description: readString(tool.args, "description"),
        prompt: readString(tool.args, "prompt"),
        // No subSessionId means the child session is unreachable regardless of
        // what the tool call's own status says.
        status: subSessionId === null ? "detached" : tool.status,
        firstToolCallId: tool.id,
    };
}

/**
 * Collapse a session's message stream into one entry per subagent.
 *
 * Keyed by subSessionId because `agentContinue` produces additional tool calls
 * against an existing child session. First occurrence wins for the descriptive
 * fields (agentContinue's args carry no description); the last occurrence wins
 * for status, so a continued subagent reads as running again.
 */
export function deriveSubagents(messages: readonly UiMessage[]): SubagentEntry[] {
    const out: SubagentEntry[] = [];
    const indexBySubSessionId = new Map<string, number>();

    for (const message of messages) {
        if (message.kind !== "assistant") continue;
        const tools = message.tools;
        if (!Array.isArray(tools)) continue;

        for (const tool of tools) {
            let entry: SubagentEntry | null = null;
            try {
                entry = entryFromTool(tool);
            } catch {
                continue;
            }
            if (entry === null) continue;

            // Detached entries have no key to merge on, so each stands alone.
            if (entry.subSessionId === null) {
                out.push(entry);
                continue;
            }

            const existingIndex = indexBySubSessionId.get(entry.subSessionId);
            if (existingIndex === undefined) {
                indexBySubSessionId.set(entry.subSessionId, out.length);
                out.push(entry);
                continue;
            }

            const existing = out[existingIndex];
            if (existing !== undefined) out[existingIndex] = { ...existing, status: entry.status };
        }
    }

    return out;
}

/** Case-insensitive match over agentType and description. */
export function filterSubagents(entries: readonly SubagentEntry[], query: string): SubagentEntry[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [...entries];
    return entries.filter(
        (e) =>
            e.agentType.toLowerCase().includes(needle) ||
            e.description.toLowerCase().includes(needle),
    );
}

/**
 * Awareness dot on the session-bar button: accent while any subagent is
 * running, dim when the session has subagents but all are terminal.
 */
export function subagentDotState(entries: readonly SubagentEntry[]): "none" | "idle" | "active" {
    if (entries.length === 0) return "none";
    return entries.some((e) => e.status === "running") ? "active" : "idle";
}

/**
 * Which subagent, if any, the panel should auto-open for.
 *
 * The trigger is a *newly appeared running* subagent, never "the list is
 * non-empty" — otherwise attaching an old session would pop the panel every
 * time. Returns the subSessionId to select, or null to leave the UI alone.
 */
export function shouldAutoOpen(
    prevIds: ReadonlySet<string>,
    next: readonly SubagentEntry[],
    alreadyOpenedThisRun: boolean,
): string | null {
    if (alreadyOpenedThisRun) return null;
    for (const entry of next) {
        if (entry.status !== "running") continue;
        if (entry.subSessionId === null) continue;
        if (prevIds.has(entry.subSessionId)) continue;
        return entry.subSessionId;
    }
    return null;
}

/**
 * Clamp a persisted or dragged width into the allowed range.
 *
 * The upper bound also tracks the viewport so a wide panel restored on a small
 * window cannot squeeze the chat column out; the lower bound wins on very
 * narrow viewports, since a panel below 220px is unusable either way.
 */
export function clampPanelWidth(raw: unknown, viewportWidth: number): number {
    if (typeof raw !== "number" || Number.isNaN(raw)) return RIGHT_PANEL_DEFAULT_WIDTH;
    const viewport =
        Number.isFinite(viewportWidth) && viewportWidth > 0
            ? viewportWidth
            : FALLBACK_VIEWPORT_WIDTH;
    const upper = Math.min(RIGHT_PANEL_MAX_WIDTH, Math.floor(viewport / 2));
    return Math.round(Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(upper, raw)));
}
