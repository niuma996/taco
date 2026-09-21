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
 * PR1 scope: in-memory only. If the parent session is not currently attached
 * (process restarted, workspace disposed) the result is dropped — this is the
 * same loss a synchronous subagent suffers if the process dies mid-run.
 * Durable cross-restart delivery is deferred to a later PR.
 */

import { isBusyError } from "../harness/harnessErrors.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";

/**
 * Send `notificationText` to `parentSessionId`, retrying through the
 * steer/followUp queue if the parent is mid-turn.
 *
 * Never throws for the "parent isn't around" case — a missing or dead
 * `AttachedSession` is a normal outcome (see module doc), not a caller error.
 * Genuine harness faults (anything that isn't a busy-lane rejection) still
 * propagate so the caller's `.catch()` can log them.
 */
export async function deliverSubagentResult(
    sessionRegistry: SessionRegistry,
    parentSessionId: Parameters<SessionRegistry["getAttached"]>[0],
    notificationText: string,
): Promise<void> {
    const attached = sessionRegistry.getAttached(parentSessionId);
    if (!attached) return;
    try {
        await attached.prompt(notificationText);
        return;
    } catch (e) {
        if (!isBusyError(e)) throw e;
    }
    const queued = await attached.enqueue("followUp", notificationText);
    if (queued.mode !== "idle") return;
    // The run ended between the busy rejection and the enqueue — the
    // followUp would sit unconsumed forever. Retry once, mirroring
    // `promptWithBusyFallback`'s same-shaped retry.
    await attached.prompt(notificationText);
}
