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

import type { AgentToolDetails, SessionId } from "@taco-ai/protocol";
import type { AgentToolResult } from "../pi/types.ts";

/** How much of the child's latest assistant text a turn update carries. */
const LAST_TEXT_MAX = 400;

function tailOf(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= LAST_TEXT_MAX) return trimmed;
    return `…${trimmed.slice(-LAST_TEXT_MAX)}`;
}

/**
 * The checkpoint published before the child does any work. Its `content` is
 * what the model reads if the call is interrupted — the session id is the
 * handle `agentContinue` needs, so it must not live in `details` alone.
 */
export function subagentStartedResult(args: {
    subSessionId: SessionId;
    agentType: string;
}): AgentToolResult<AgentToolDetails> {
    const { subSessionId, agentType } = args;
    return {
        content: [
            {
                type: "text",
                text:
                    `Subagent ${agentType} running as session ${subSessionId}. ` +
                    "If this call is interrupted, resume that session with agentContinue " +
                    "instead of spawning a new subagent.",
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
}): AgentToolResult<AgentToolDetails> {
    const { subSessionId, agentType, turns, lastText } = args;
    const tail = lastText === undefined ? "" : tailOf(lastText);
    const head = `Subagent ${agentType}: turn ${turns}`;
    return {
        content: [{ type: "text", text: tail.length > 0 ? `${head}\n\n${tail}` : head }],
        details: { subSessionId, agentType, turns },
    };
}
