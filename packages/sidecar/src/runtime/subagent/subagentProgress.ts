/**
 * Progress payloads for the subagent-backed tools (`agent`, `agentContinue`,
 * and subagent-mode `skill`).
 *
 * One runner serves all three entry points, so the update shapes live here
 * rather than in each tool: tools forward their pi `onUpdate` callback down the
 * spawn context, and `subagentRunner` decides when to publish.
 *
 * Two kinds of update ride the same channel:
 *  - the started update is a durable checkpoint, published once the child
 *    session exists. pi folds checkpoint content into the interrupted tool
 *    result, so the child's session id travels in `content` (model-visible on
 *    interruption) rather than `details` (never sent to the model).
 *  - turn updates are live-only — they feed the desktop's running tool card and
 *    cost no durable write.
 */

import type { SessionId, SubagentProgressDetails } from "@taco-ai/protocol";
import type { AgentMessage, AgentToolResult } from "../pi/types.ts";

/** How much of the child's latest assistant text a turn update carries. */
const LAST_TEXT_MAX = 400;

/**
 * Text parts of one assistant message, joined.
 *
 * `turn_end` hands over the message that just completed, so progress needs no
 * session read. Thinking blocks and tool calls are skipped: the former is not
 * the child's answer, and the latter is already visible as its own tool card.
 */
export function assistantText(message: AgentMessage): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const { type, text } = part as { type?: unknown; text?: unknown };
        if (type === "text" && typeof text === "string" && text.length > 0) parts.push(text);
    }
    return parts.join("\n");
}

/**
 * Bounded tail of the child's latest message.
 *
 * Tail rather than head: the newest sentence says what the child is doing now,
 * which is what both a watching user and a resuming model need. Only turn
 * updates carry it, and those are live-only — see the module comment on why the
 * durable checkpoint stays free of unbounded child text.
 */
function tailOf(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= LAST_TEXT_MAX) return trimmed;
    return `…${trimmed.slice(-LAST_TEXT_MAX)}`;
}

/**
 * Whether the model can resume this child with `agentContinue` after an
 * interruption. Only spawns made through an agent *profile* can: `agentContinue`
 * re-derives the child's toolset from its `agentType` and fails closed when no
 * definition matches (see AgentSpawner.runResume), and a skill subagent's
 * `skill:<name>` agentType is never in the agent registry. Telling the model to
 * resume one would send it down a path that always errors.
 */
export type SubagentResumability = "resumable" | "not_resumable";

/**
 * The checkpoint published before the child does any work. Its `content` is
 * what the model reads if the call is interrupted — the session id is the
 * handle `agentContinue` needs, so it must not live in `details` alone.
 *
 * Kept short and free of child output on purpose: pi stores one checkpoint per
 * invocation and this is the only durable write on the subagent path, so it
 * carries the recovery handle and nothing that grows with the run.
 */
export function subagentStartedResult(args: {
    subSessionId: SessionId;
    agentType: string;
    resumability: SubagentResumability;
}): AgentToolResult<SubagentProgressDetails> {
    const { subSessionId, agentType, resumability } = args;
    const guidance =
        resumability === "resumable"
            ? "If this call is interrupted, resume that session with agentContinue " +
              "instead of spawning a new subagent."
            : "If this call is interrupted, its work is in that session but it cannot " +
              "be resumed — re-invoke this tool instead.";
    return {
        content: [
            {
                type: "text",
                text: `Subagent ${agentType} running as session ${subSessionId}. ${guidance}`,
            },
        ],
        details: { subSessionId, agentType },
    };
}

/** One live turn update: turn count plus a bounded tail of the child's latest message. */
export function subagentTurnResult(args: {
    subSessionId: SessionId;
    agentType: string;
    turns: number;
    lastText?: string;
}): AgentToolResult<SubagentProgressDetails> {
    const { subSessionId, agentType, turns, lastText } = args;
    const tail = lastText === undefined ? "" : tailOf(lastText);
    const head = `Subagent ${agentType}: turn ${turns}`;
    return {
        content: [{ type: "text", text: tail.length > 0 ? `${head}\n\n${tail}` : head }],
        details: { subSessionId, agentType, turns },
    };
}
