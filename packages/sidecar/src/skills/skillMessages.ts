/**
 * $ARGUMENTS: replace placeholder if present; otherwise append at the end.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Replace every $ARGUMENTS placeholder with the caller's args string.
 * Uses a function replacer so special replacement patterns ($$/$&/$'/$) in args
 * are treated as literals, not regex instructions.
 */
export function interpolateArgs(body: string, args: string): string {
    if (body.includes("$ARGUMENTS")) {
        return body.replace(/\$ARGUMENTS/g, () => args);
    }
    return args ? `${body}\n\nArguments: ${args}` : body;
}

/**
 * Build a user message wrapping the skill body with a `<skill_body:NAME>` tag.
 * Used for both one-shot activations (pending queue) and reinjection after compaction.
 */
export function createSkillBodyMessage(
    skill: { name: string; content: string },
    args = "",
): AgentMessage {
    const body = interpolateArgs(skill.content, args);
    return {
        role: "user",
        content: `<skill_body:${skill.name}>\n\n${body}`,
        timestamp: Date.now(),
    };
}
