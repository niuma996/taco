/**
 * Deliver a background subagent's result to its parent session.
 *
 * A `background: true` spawn returns to the caller as soon as the child
 * session exists, and the original tool call already returned its launch
 * receipt — so the parent's conversation is the only channel left for the
 * result.
 *
 * In-memory only: with no attached parent there is no `AttachedSession` to
 * prompt, and the notice cannot land here. That is not a lost result —
 * `subagentPending.ts` records the notice before this call and clears it only
 * on success, so the next attach can retry.
 */

import { isBusyError } from "../harness/harnessErrors.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";

/**
 * How the notice reached the parent.
 *
 *  - `replied`: the parent was idle. A fresh run answered the notice, and
 *    that run's assistant reply is what the user was told.
 *  - `queued`: the parent was mid-turn. The notice sits in its follow-up queue
 *    and the reply that follows is the ordinary output of the run in flight.
 *  - `unreachable`: the parent is not attached, so nothing was delivered.
 */
export type SubagentDeliveryOutcome = "replied" | "queued" | "unreachable";

/**
 * Send `notificationText` to `parentSessionId`, retrying through the
 * steer/followUp queue if the parent is mid-turn.
 *
 * `unreachable` (not a throw) for the "parent isn't around" case — a missing
 * or dead `AttachedSession` is a normal outcome (see module doc), not a
 * caller error; the caller must not treat this the same as a delivered notice,
 * or it will clear the pending record for a notice nobody received. Genuine
 * harness faults (anything that isn't a busy-lane rejection) still throw so the
 * caller's `.catch()` can log them — those are unexpected, not the
 * "unreachable parent" case this outcome exists to distinguish.
 *
 * `onRunStart` fires with the operation id just before the idle prompt is sent,
 * so a caller that needs to recognise that run's events (the Work layer holds
 * the reply back from the channel) can do so before any of them are emitted.
 */
export async function deliverSubagentResultDetailed(
    sessionRegistry: SessionRegistry,
    parentSessionId: Parameters<SessionRegistry["getAttached"]>[0],
    notificationText: string,
    hooks?: {
        beforePrompt?: () => void;
        /** `ran` is false when the attempt was rejected before any run started. */
        afterPrompt?: (reply: string | undefined, ran: boolean) => void;
    },
): Promise<SubagentDeliveryOutcome> {
    const attached = sessionRegistry.getAttached(parentSessionId);
    if (!attached) return "unreachable";
    try {
        hooks?.beforePrompt?.();
        const reply = await attached.prompt(notificationText);
        hooks?.afterPrompt?.(replyText(reply), true);
        return "replied";
    } catch (e) {
        if (!isBusyError(e)) {
            hooks?.afterPrompt?.(undefined, true);
            throw e;
        }
        // Rejected at admission: no run started, so there is no reply to wait for.
        hooks?.afterPrompt?.(undefined, false);
    }
    const queued = await attached.enqueue("followUp", notificationText);
    if (queued.mode !== "idle") return "queued";
    // The run ended between the busy rejection and the enqueue — the
    // followUp would sit unconsumed forever. Retry once, mirroring
    // `promptWithBusyFallback`'s same-shaped retry.
    hooks?.beforePrompt?.();
    try {
        const reply = await attached.prompt(notificationText);
        hooks?.afterPrompt?.(replyText(reply), true);
    } catch (e) {
        hooks?.afterPrompt?.(undefined, true);
        throw e;
    }
    return "replied";
}

/** The visible text of a prompt reply; a toolResult (askUser) carries none. */
function replyText(reply: unknown): string | undefined {
    const message = reply as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
    const text = message.content
        .filter(
            (b): b is { type: "text"; text: string } =>
                typeof b === "object" &&
                b !== null &&
                (b as { type?: unknown }).type === "text" &&
                typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("")
        .trim();
    return text === "" ? undefined : text;
}

/**
 * Boolean form kept for the callers that only need "did it land": a notice
 * counts as delivered when it was answered or safely queued.
 */
export async function deliverSubagentResult(
    sessionRegistry: SessionRegistry,
    parentSessionId: Parameters<SessionRegistry["getAttached"]>[0],
    notificationText: string,
): Promise<boolean> {
    return (
        (await deliverSubagentResultDetailed(
            sessionRegistry,
            parentSessionId,
            notificationText,
        )) !== "unreachable"
    );
}
