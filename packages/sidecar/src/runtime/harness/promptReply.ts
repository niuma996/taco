/**
 * Branch-tip reply validation for `AttachedSession.prompt()`.
 *
 * Split out of `AttachedSession` because it is a pure predicate over pi's own
 * `AgentMessage` / `Entry` shapes — the session layer only asks it whether the
 * tip it read back is a usable reply.
 */

import type { AgentMessage, Entry } from "../pi/types.ts";

/**
 * Whether `prompt()` should accept a branch-tip entry as a valid reply, or
 * surface the "expected an assistant reply" anomaly.
 *
 * The expected shape is an assistant message. The exception is a toolResult
 * entry whose `MessageEntry.terminate` is `true` — pi 0.85 lets a turn finish
 * on such an entry (askUser / planExit-style close) and reports
 * `status: "completed"` with the toolResult as the branch tip. Returning it
 * directly keeps the desktop from seeing a misleading error and from
 * `sessionDelete`-ing the freshly created session in its `sessionPrompt` catch.
 *
 * Any other non-assistant tip (a toolResult without `terminate`, a
 * compaction / branch_summary entry, an aborted-and-resumed anomaly) is a real
 * shape problem and is rejected — silent acceptance would mask upstream
 * invariant changes.
 *
 * `entry` is typed as pi's own `Entry` union rather than `unknown` so that a
 * rename of `MessageEntry.terminate` upstream breaks the build here instead of
 * silently degrading to "always reject" (which would reinstate the bug).
 */
export function resolvePromptReply(
    reply: AgentMessage | undefined,
    entry: Entry | undefined,
): "accept" | "reject" {
    if (reply === undefined) return "reject";
    if (reply.role === "assistant") return "accept";
    const terminating =
        entry?.type === "message" && entry.terminate === true && reply.role === "toolResult";
    return terminating ? "accept" : "reject";
}
