/**
 * Deliver a background subagent's result to its parent session.
 *
 * A `background: true` spawn returns to the caller as soon as the child
 * session exists (see `agentSpawner.ts`). When the child later settles, its
 * result has nowhere to go except back into the parent's conversation — the
 * original tool call already returned its launch receipt, so this is the
 * only channel left.
 *
 * The delivery mirrors the prompt→busy→followUp→retry pattern the scheduler
 * already uses for the same problem (`scheduler/dispatcher.ts`
 * `promptWithBusyFallback`), but at a lower layer: the scheduler talks to
 * `SidecarServer.dispatchRpc` (`session.prompt` / `session.followUp` methods,
 * `ErrorCodes.SessionBusy`), while a spawn only has `SessionRegistry` and can
 * reach the parent's `AttachedSession` directly. Same shape, different rung:
 *
 *   prompt() -> busy? -> enqueue("followUp") -> idle? -> retry prompt() once
 *
 * This function itself is in-memory only — if the parent session is not
 * currently attached (process restarted, workspace disposed), there is no
 * `AttachedSession` to prompt and the notice cannot land here. That is not a
 * lost result, though: `deliverSubagentResult` reports it via its boolean
 * return, and `subagentPending.ts` is the durable half of this pair — it
 * records the notice before this function is called and only clears the
 * record once this function reports success, so the next attach can retry.
 */

import { isBusyError } from "../harness/harnessErrors.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";

/**
 * Send `notificationText` to `parentSessionId`, retrying through the
 * steer/followUp queue if the parent is mid-turn.
 *
 * Returns whether the notice actually reached the parent. `false` (not a
 * throw) for the "parent isn't around" case — a missing or dead
 * `AttachedSession` is a normal outcome (see module doc), not a caller error;
 * the caller must not treat this the same as a delivered notice, or it will
 * clear the pending record for a notice nobody received. Genuine harness
 * faults (anything that isn't a busy-lane rejection) still throw so the
 * caller's `.catch()` can log them — those are unexpected, not the
 * "unreachable parent" case this return value exists to distinguish.
 */
export async function deliverSubagentResult(
    sessionRegistry: SessionRegistry,
    parentSessionId: Parameters<SessionRegistry["getAttached"]>[0],
    notificationText: string,
): Promise<boolean> {
    const attached = sessionRegistry.getAttached(parentSessionId);
    if (!attached) return false;
    try {
        await attached.prompt(notificationText);
        return true;
    } catch (e) {
        if (!isBusyError(e)) throw e;
    }
    const queued = await attached.enqueue("followUp", notificationText);
    if (queued.mode !== "idle") return true;
    // The run ended between the busy rejection and the enqueue — the
    // followUp would sit unconsumed forever. Retry once, mirroring
    // `promptWithBusyFallback`'s same-shaped retry.
    await attached.prompt(notificationText);
    return true;
}
