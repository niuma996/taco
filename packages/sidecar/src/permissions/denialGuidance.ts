/**
 * Denial guidance for a refused approval.
 *
 * Shared by every tool that goes through the permission broker (the shell
 * tool, the config tools). The wording is the same in each place, so it
 * lives here: a model that learns "a denial is final" from one tool should
 * not have to relearn it from another.
 *
 * The text widens "do not retry" to "do not attempt the same outcome by
 * another route", because models otherwise read a denial as "use a
 * different string" and re-attempt it through a pipe, a sibling tool, or a
 * split-up request. A denial is about the intent, not the exact form.
 *
 * The reason changes what the model should do next:
 *   - `user_denied`  — a person said no. Re-asking the same thing is
 *     nagging; the model should stop and let the user lead.
 *   - `timeout` — nobody answered. Asking is still reasonable.
 *   - `aborted` — the turn was cancelled. Not a judgement on the action.
 *   - `no_approver` — no desktop app is connected, so there is no UI to
 *     ask on.
 *   - `im_channel` — an IM conversation, where approvals are refused
 *     outright. The person on the channel can still be asked in a reply.
 *   - `undefined` — blocked by policy before any UI (a deny rule, a
 *     read-only broker, an IM channel policy). Nobody was asked, so there
 *     is no user to route a question to.
 */

import type { CommandPermissionDenialReason } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("permissions");

/** What was refused, and how the model might reach the same outcome. */
export interface DenialSubject {
    /** The action, in the model's terms: "this command", "the configuration change". */
    readonly action: string;
    /**
     * The routes to the same outcome that the model is told are equally
     * denied: "a different command, a pipeline, or another tool that has
     * the same effect". Naming them is what stops a model from picking
     * one.
     */
    readonly alternativeRoutes: string;
}

/**
 * The guidance text for a refused approval.
 *
 * `reason` is the broker's `CommandPermissionDenialReason`; `undefined`
 * means the request never reached the UI.
 */
export function denialGuidance(
    reason: CommandPermissionDenialReason | undefined,
    subject: DenialSubject,
): string {
    const { action, alternativeRoutes } = subject;
    if (reason === "no_approver") {
        return (
            "[denied] This needs approval in the Taco desktop app, and no desktop app is " +
            "connected right now. Do not retry it or work around it. Tell the user it needs " +
            "approval in the Taco desktop app, then continue without it or stop."
        );
    }
    if (reason === "im_channel") {
        return (
            `[denied] ${action} needs approval, and approvals are not available in this chat ` +
            "channel, so it was refused automatically and did not run. Do not retry it, and do " +
            `not attempt the same outcome by another route — ${alternativeRoutes} — is still the ` +
            "refused action. Stop, tell the user what you were trying to do and that it needs " +
            "approval, and ask how they want to proceed. A reply in this chat is the only way to " +
            "ask; the user can run it from the Taco desktop app or adjust the channel's " +
            "permission settings."
        );
    }
    if (reason === "timeout") {
        return (
            "[denied] The permission request timed out before the user responded. Do not retry " +
            `automatically; if you still need ${action}, call \`askUser\` to ask the user — or, ` +
            "if you have no `askUser` tool (you are a subagent), report it in your final reply. " +
            "Otherwise wait for a new instruction."
        );
    }
    if (reason === "aborted") {
        return (
            "[cancelled] The action was not performed because the current turn was cancelled " +
            "while waiting for permission. Do not retry automatically."
        );
    }
    if (reason === undefined) {
        // Blocked by policy, not by a person. Nobody was asked, so there is
        // no user in front of the model to ask.
        return (
            `[denied] ${action} was blocked by the workspace's permission policy, not by the ` +
            "user. Do not retry it, and do not attempt the same outcome by another route — " +
            `${alternativeRoutes} — is still blocked. Explain why it was blocked and stop; if it ` +
            "should be allowed, ask the user to change the policy."
        );
    }
    if (reason !== "user_denied") {
        // The broker emitted a reason this build does not know about. Fall
        // through to the "user denied" text, but flag it so it is visible in
        // the logs rather than silently reading as a refusal.
        log.warn("unrecognised permission denial reason", { reason: String(reason) });
    }
    return (
        `[denied] The user denied ${action}. Do not retry it, and do not attempt the same outcome ` +
        `by another route — ${alternativeRoutes} — is still the denied action. The denial is ` +
        "about the intent, not the exact form of the request. If you still need that outcome, " +
        "stop and call `askUser` to ask how the user wants to proceed — or, if you have no " +
        "`askUser` tool (you are a subagent), report the denial in your final reply; otherwise " +
        "wait for a new instruction."
    );
}
