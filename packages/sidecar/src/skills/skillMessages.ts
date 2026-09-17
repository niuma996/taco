/**
 * Skill body argument interpolation.
 *
 * Local implementation. Considered switching to pi-agent-core's
 * `substituteArgs` (which covers `$1` / `$2` / `${@:N}` / `${@:N:L}` in
 * addition to `$ARGUMENTS` / `$@`), but pi's implementation uses a string
 * replacement for `$ARGUMENTS`, which makes JavaScript's
 * `String.prototype.replace` interpret `$$` / `$&` / `$'` / `` $` `` in the
 * `args` text as special tokens — a real corner-case bug for any user whose
 * args contains those characters. The cost of a safe wrapper around pi is
 * higher than the cost of keeping a local function-replacer implementation.
 *
 * Function replacers throughout so $$/$&/$'/$\` in args are treated as
 * literals, matching the original taco behavior byte-for-byte.
 *
 * Legacy fallback: when the body has no `$ARGUMENTS` placeholder at all and
 * the caller supplied non-empty args, append `\n\nArguments: {args}` so SKILL.md
 * files that never used the placeholder still get the args surfaced.
 */

import type { AgentMessage } from "../runtime/pi/types.ts";

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
