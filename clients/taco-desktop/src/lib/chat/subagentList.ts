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
import { AGENT_TOOL_NAMES } from "./chatUtils";
import type { BackgroundSubagentState } from "./workspaceReducer";

/**
 * Two states here are not `ToolCallStatus` values.
 *
 * `detached` — an agent call whose toolResult never landed (sidecar killed
 * mid-run) has no persisted subSessionId, so its child session can no longer be
 * opened.
 *
 * `background` — a `background: true` spawn's tool call reports `ok` from the
 * moment it launches, because its result is the launch receipt rather than the
 * child's answer. Deriving liveness from the tool call would show such a child
 * as finished while it is still working, so this state comes from the workspace's
 * background-subagent record instead (see `deriveSubagents`).
 *
 * `aborted` — a background child stopped deliberately (panel stop button,
 * `agentAbort`, or its wall-clock timeout). Kept distinct from `error`: a stop
 * the user asked for is not a failure.
 */
export type SubagentStatus = "running" | "background" | "ok" | "error" | "detached" | "aborted";

export interface SubagentEntry {
    /** null means detached — no child session to bind. */
    subSessionId: string | null;
    agentType: string;
    description: string;
    prompt: string;
    status: SubagentStatus;
    /** Tool call that first introduced this subagent; used as a stable React key. */
    firstToolCallId: string;
    conversationStatus?: string;
    conversationRunId?: string;
    conversationToolCallId?: string;
}

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
function entryFromTool(
    tool: UiToolCall,
    backgroundSubagents: Readonly<Record<string, BackgroundSubagentState>>,
): SubagentEntry | null {
    if (!AGENT_TOOL_NAMES.has(tool.name)) return null;
    // A call without a real id or status is malformed — throw so the caller's
    // try/catch skips it instead of emitting a bogus panel row.
    if (typeof tool.id !== "string") throw new Error("agent tool call missing id");
    if (!TOOL_CALL_STATUSES.has(tool.status)) throw new Error("agent tool call missing status");

    // Older failed runs wrote the id only into the result text. Recover it so
    // reopening the parent does not turn an inspectable child into "detached".
    const legacyId = tool.resultText?.match(/\[subagent session: ([0-9a-f-]{36})\]/i)?.[1];
    const subSessionId = readString(tool.details, "subSessionId") || legacyId || null;
    const detailStatus = readString(tool.details, "status");
    const agentType =
        readString(tool.details, "agentType") || readString(tool.args, "subagent_type") || "agent";

    return {
        subSessionId,
        agentType,
        description: readString(tool.args, "description"),
        prompt: readString(tool.args, "prompt"),
        // No subSessionId means the child session is unreachable regardless of
        // what the tool call's own status says.
        status:
            subSessionId === null
                ? "detached"
                : detailStatus === "aborted"
                  ? "aborted"
                  : backgroundStatus(tool.id, backgroundSubagents, tool.status),
        firstToolCallId: tool.id,
        ...(readString(tool.details, "runId")
            ? { conversationRunId: readString(tool.details, "runId") }
            : {}),
    };
}

/**
 * Status for a tool call that may be a background launch.
 *
 * Falls through to the tool call's own status for every synchronous spawn. For a
 * background one the tool call is useless as a liveness signal — it reports `ok`
 * from launch — so the workspace record decides instead.
 */
function backgroundStatus(
    toolCallId: string,
    backgroundSubagents: Readonly<Record<string, BackgroundSubagentState>>,
    fallback: ToolCallStatus,
): SubagentStatus {
    switch (backgroundSubagents[toolCallId]) {
        case "running":
            return "background";
        case "completed":
            return "ok";
        case "error":
            return "error";
        case "aborted":
            return "aborted";
        default:
            return fallback;
    }
}

/**
 * Collapse a session's message stream into one entry per subagent.
 *
 * Keyed by subSessionId because repeated `agent` history can refer to an
 * existing child session. First occurrence wins for descriptive fields; the
 * last occurrence wins for status.
 *
 * `backgroundSubagents` is the one input that is not derivable from the message
 * stream. A background spawn's tool call settles at launch, so the stream says
 * `ok` for the whole time the child is actually working; only the workspace's
 * record (fed by the `subagent.settled` push) knows the difference. Passing it
 * in keeps this function pure while letting it correct that one status.
 */
export function deriveSubagents(
    messages: readonly UiMessage[],
    backgroundSubagents: Readonly<Record<string, BackgroundSubagentState>> = {},
    backgroundRunIds: Readonly<Record<string, string>> = {},
): SubagentEntry[] {
    const out: SubagentEntry[] = [];
    const indexBySubSessionId = new Map<string, number>();
    const currentRuns = new Map<string, { status: SubagentStatus; runId: string }>();
    const conversations = new Map<string, { status: string; runId?: string; toolCallId: string }>();

    for (const message of messages) {
        if (message.kind !== "assistant") continue;
        const tools = message.tools;
        if (!Array.isArray(tools)) continue;

        for (const tool of tools) {
            if (tool.name === "chatToAgent") {
                const subSessionId =
                    readString(tool.details, "subSessionId") ||
                    readString(tool.args, "subSessionId");
                const status = readString(tool.details, "status");
                if (subSessionId !== "" && status !== "") {
                    conversations.set(subSessionId, {
                        status,
                        runId: readString(tool.details, "runId") || undefined,
                        toolCallId: tool.id,
                    });
                }
            }
            let entry: SubagentEntry | null = null;
            try {
                entry = entryFromTool(tool, backgroundSubagents);
            } catch {
                continue;
            }
            if (entry === null) continue;
            if (
                entry.subSessionId &&
                readString(tool.details, "runId") &&
                backgroundSubagents[tool.id] !== undefined &&
                backgroundRunIds[tool.id] !== undefined
            )
                currentRuns.set(entry.subSessionId, {
                    status: backgroundStatus(tool.id, backgroundSubagents, tool.status),
                    runId: backgroundRunIds[tool.id],
                });

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

    return out.map((entry) => {
        const currentRun = entry.subSessionId ? currentRuns.get(entry.subSessionId) : undefined;
        const status = currentRun?.status;
        const conversation = entry.subSessionId ? conversations.get(entry.subSessionId) : undefined;
        const matchesCurrent =
            !currentRun || !conversation?.runId || conversation.runId === currentRun.runId;
        const active =
            status === "background" || entry.status === "running" || entry.status === "background";
        const latestStatus = matchesCurrent ? conversation?.status : undefined;
        const conversationStatus: SubagentStatus | undefined =
            latestStatus === "completed"
                ? "ok"
                : latestStatus === "error"
                  ? "error"
                  : latestStatus === "aborted"
                    ? "aborted"
                    : undefined;
        return {
            ...entry,
            status: active
                ? (status ?? entry.status)
                : (conversationStatus ?? status ?? entry.status),
            ...(conversation
                ? {
                      conversationStatus: conversation.status,
                      ...(currentRun?.runId || conversation.runId
                          ? { conversationRunId: currentRun?.runId ?? conversation.runId }
                          : {}),
                      conversationToolCallId: conversation.toolCallId,
                  }
                : {}),
        };
    });
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
    // `background` counts as running: the child is still working, which is
    // exactly what this dot is for. Only its tool call has finished.
    return entries.some((e) => e.status === "running" || e.status === "background")
        ? "active"
        : "idle";
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
        // `background` is a running child too — only its tool call has
        // finished. Before that status existed such an entry read as
        // "running" here, so skipping it would be a regression (the dot
        // lights but the panel never opens).
        if (entry.status !== "running" && entry.status !== "background") continue;
        if (entry.subSessionId === null) continue;
        if (prevIds.has(entry.subSessionId)) continue;
        return entry.subSessionId;
    }
    return null;
}

/**
 * Whether the task panel should auto-open: a task list that was not active at
 * the last evaluation just became the active one. The same id staying active
 * (tasks ticking off) and the list going away both leave the UI alone.
 */
export function shouldAutoOpenTasks(
    prevActiveId: string | null,
    nextActiveId: string | null,
): boolean {
    return nextActiveId !== null && nextActiveId !== prevActiveId;
}
