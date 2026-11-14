import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import { tagWrap } from "../../tags/builder.ts";
import type { BackgroundWorkHooks } from "../../work/workHooks.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import { deliverSubagentResult, deliverSubagentResultDetailed } from "./subagentDelivery.ts";

type NoticeHooks = Pick<
    BackgroundWorkHooks,
    | "beginParentNotice"
    | "endParentNotice"
    | "runParentNotice"
    | "onNoticeRunStart"
    | "onNoticeRunRelease"
>;

/** Claims and delivers parent awareness using the committed Work snapshot when available. */
export class SubagentNoticeDelivery {
    constructor(
        private readonly sessionRegistry: SessionRegistry,
        private readonly workspaceKey: WorkspaceId,
        private readonly workHooks?: NoticeHooks,
    ) {}
    async deliverNotice(
        parentSessionId: SessionId,
        notification: string,
        workId: string | undefined,
        trackedOnly = false,
        tracked = true,
        legacyWorkId?: string,
        expectedAttemptId?: string,
        late = false,
    ): Promise<boolean> {
        const hooks = this.workHooks;
        if (!hooks || workId === undefined)
            return deliverSubagentResult(this.sessionRegistry, parentSessionId, notification);
        const decision = await hooks.beginParentNotice(
            workId,
            tracked,
            { workspace: this.workspaceKey, sessionId: parentSessionId },
            legacyWorkId,
            expectedAttemptId,
        );
        if (decision.mode === "skip") return !decision.retry;
        if (decision.mode === "legacy") {
            if (trackedOnly) return false;
            return deliverSubagentResult(this.sessionRegistry, parentSessionId, notification);
        }
        workId = decision.workId ?? workId;
        if (decision.notice?.subSessionId) {
            notification = formatBackgroundNotification(decision.notice.agentType ?? "unknown", {
                ...decision.notice,
                subSessionId: asSessionId(decision.notice.subSessionId),
                late,
            });
        }

        let held = false;
        let ran = false;
        let reply: string | undefined;
        const release = (): void => {
            if (!held) return;
            held = false;
            hooks.onNoticeRunRelease(workId, parentSessionId);
        };
        try {
            const run = () =>
                deliverSubagentResultDetailed(this.sessionRegistry, parentSessionId, notification, {
                    enqueueWhenBusy: false,
                    beforePrompt: () => {
                        hooks.onNoticeRunStart(workId, parentSessionId, this.workspaceKey);
                        held = true;
                    },
                    afterPrompt: (text, didRun) => {
                        ran = didRun;
                        reply = text;
                        if (!didRun) release();
                    },
                });
            const outcome = hooks.runParentNotice
                ? await hooks.runParentNotice(workId, decision.claimId, parentSessionId, run)
                : await run();
            return outcome === "replied";
        } finally {
            try {
                await hooks.endParentNotice(workId, decision.claimId, {
                    status: ran ? "completed" : "not_run",
                    ...(reply === undefined ? {} : { reply }),
                });
            } finally {
                release();
            }
        }
    }
}

export function formatBackgroundNotification(
    agentType: string,
    result: {
        subSessionId: SessionId;
        resultText?: string;
        outcome: "completed" | "error" | "aborted";
        path?: string;
        /**
         * The task label from the original `agent` call. Repeated here
         * because the notice can land many turns later: the conversation has
         * moved on, and a compaction in between may have collapsed the tool
         * call that would otherwise say what this subagent was for.
         */
        description?: string;
        /**
         * Re-delivery of a notice the parent missed while unreachable. Said
         * out loud because the model may have already told the user this
         * subagent was still running, and it needs to correct that rather
         * than present stale news as fresh.
         */
        late?: boolean;
    },
): string {
    const status = result.outcome;
    const located = result.path
        ? `Its full output is saved at: ${result.path}\nThat text is NOT included here — the file is the only copy.`
        : "Its output could not be saved to disk, so the detail is unavailable. Say so rather than guessing at it.";
    const guidance =
        result.outcome === "aborted"
            ? "This task was stopped deliberately — by the user or by its own time limit. Tell the user in one sentence that it was stopped, and do not restart or respawn it unless they ask."
            : result.outcome === "error"
              ? "Read that file before replying: it holds the error and, if the subagent got partway, how far it got and whether it can be resumed. Then tell the user in one sentence that this background task failed, and propose a next step based on what you read. Do not present its output as a result."
              : "Read that file with the read tool now, before you reply. Then tell the user, in your own words, that this background task came back and what it found — do not just hand them the path, and do not claim it is still running. If what you read changes what you were doing, say so.";
    const lateness = result.late
        ? " This notice is late — it could not be delivered when the subagent actually" +
          " finished, so if you previously told the user it was still running, correct that."
        : "";
    // In the body, not an attribute: `tagWrap` escapes attribute values but
    // not the body, and this is the one part of the envelope that is
    // model-authored text. The body is safe because the balanced parser does
    // not nest — a forged tag inside it stays inside it.
    const task = result.description ? `\nIts task was: ${result.description}` : "";
    return tagWrap(
        "subagent_result",
        `The ${agentType} subagent you launched in the background has finished (outcome: ${status}).` +
            `${lateness}${task}\n` +
            `${located}\n\n` +
            guidance,
        {
            "agent-type": agentType,
            session: result.subSessionId,
            outcome: status,
            ...(result.path ? { path: result.path } : {}),
            ...(result.late ? { late: "true" } : {}),
        },
    );
}
