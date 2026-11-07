import type { AgentMessage, SessionTarget } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { isAbortedTurn, isBusyError } from "../runtime/harness/harnessErrors.ts";
import { resolveWaitingInteraction } from "../runtime/session/waitingInteraction.ts";
import type { WorkController } from "./workController.ts";
import type { WorkStore } from "./workStore.ts";
import type { WorkRecord } from "./workTypes.ts";

const log = createLogger("sidecar.work.reconciler");
interface ResumedWork {
    snapshot: WorkRecord;
    attemptId: string;
}

/** Continue the Work that owns an answered interaction; harness driving remains with the caller. */
export class WorkReconciler {
    constructor(
        private readonly store: WorkStore,
        private readonly controller: WorkController,
    ) {}

    private async begin(target: SessionTarget, toolCallId: string): Promise<ResumedWork[]> {
        const attempts: ResumedWork[] = [];
        try {
            const waiting = (await this.store.list()).filter(
                (work) =>
                    work.workspace === target.workspace &&
                    work.status === "waiting" &&
                    work.waiting?.sessionId === target.sessionId &&
                    work.waiting.toolCallId === toolCallId,
            );
            for (const snapshot of waiting) {
                const resumed = await this.controller.resumeAttempt(snapshot.workId, toolCallId);
                if (resumed) attempts.push({ snapshot, attemptId: resumed.attempt.attemptId });
            }
        } catch (error) {
            log.error("could not record continuation start", { error: String(error) });
        }
        return attempts;
    }

    private async record(workId: string, update: () => Promise<unknown>): Promise<void> {
        try {
            await update();
        } catch (error) {
            log.error("could not record continuation outcome", { workId, error: String(error) });
        }
    }

    async answer(
        target: SessionTarget,
        toolCallId: string,
        run: () => Promise<AgentMessage>,
    ): Promise<AgentMessage> {
        const attempts = await this.begin(target, toolCallId);
        let reply: AgentMessage;
        try {
            reply = await run();
        } catch (error) {
            for (const { snapshot, attemptId } of attempts) {
                await this.record(snapshot.workId, () =>
                    isBusyError(error)
                        ? this.controller.restoreWaiting(snapshot, attemptId)
                        : this.controller.settle({
                              workId: snapshot.workId,
                              attemptId,
                              outcome: isAbortedTurn(error) ? "aborted" : "error",
                              resultText: "",
                              reason: error instanceof Error ? error.message : String(error),
                              deliver: false,
                              parentWillReply: false,
                          }),
                );
            }
            throw error;
        }
        const waiting = resolveWaitingInteraction(reply, target.sessionId);
        for (const { snapshot, attemptId } of attempts) {
            await this.record(snapshot.workId, () =>
                waiting
                    ? this.controller.waitForInput(snapshot.workId, waiting, attemptId)
                    : this.controller.settle({
                          workId: snapshot.workId,
                          attemptId,
                          outcome: "completed",
                          resultText:
                              reply.role === "assistant"
                                  ? reply.content
                                        .flatMap((block) =>
                                            block.type === "text" ? [block.text] : [],
                                        )
                                        .join("\n")
                                  : "",
                          deliver: false,
                          parentWillReply: false,
                      }),
            );
        }
        return reply;
    }
}
