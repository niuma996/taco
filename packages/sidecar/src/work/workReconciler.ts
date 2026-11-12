import type { AgentMessage, SessionTarget } from "@taco-ai/protocol";
import { ErrorCodes } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { textBlocks } from "../lib/textBlocks.ts";
import { isAbortedTurn, isBusyError } from "../runtime/harness/harnessErrors.ts";
import { resolveWaitingInteraction } from "../runtime/session/waitingInteraction.ts";
import type { WorkController } from "./workController.ts";
import type { WorkAnswerContext } from "./workOperationTypes.ts";
import { restoreInterruptedAttempt } from "./workState.ts";
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
        private readonly runWork?: <T>(
            workId: string,
            sessionId: string,
            run: () => Promise<T>,
        ) => Promise<T>,
    ) {}

    private async begin(
        target: SessionTarget,
        toolCallId: string,
        context?: WorkAnswerContext,
    ): Promise<ResumedWork[]> {
        const attempts: ResumedWork[] = [];
        try {
            if (await this.store.isInteractionInvalidated(target, toolCallId))
                throw Object.assign(
                    new Error("this Work interaction has expired or was cancelled"),
                    { code: ErrorCodes.InvalidState },
                );
            const all = await this.store.list();
            const recovered = context
                ? all.find(
                      (work) =>
                          work.workspace === target.workspace &&
                          work.attempt.operation?.operationId === context.operationId &&
                          work.attempt.interaction?.sessionId === target.sessionId &&
                          work.attempt.interaction.toolCallId === toolCallId,
                  )
                : undefined;
            const bound =
                context?.attempt ??
                (recovered
                    ? { workId: recovered.workId, attemptId: recovered.attempt.attemptId }
                    : undefined);
            if (bound) {
                const work = all.find((record) => record.workId === bound.workId);
                if (
                    !work ||
                    work.workspace !== target.workspace ||
                    work.attempt.attemptId !== bound.attemptId ||
                    work.attempt.cancelRequestedAt !== undefined ||
                    work.attempt.operation?.operationId !== context?.operationId ||
                    work.attempt.interaction?.toolCallId !== toolCallId ||
                    work.attempt.interaction.sessionId !== target.sessionId
                ) {
                    throw Object.assign(
                        new Error("the answered Work attempt was cancelled, deleted or replaced"),
                        { code: ErrorCodes.InvalidState },
                    );
                }
                if (work.status === "interrupted" && !work.expiredInteraction) {
                    const restored = await this.store.mutate(work.workId, (current) =>
                        current.revision === work.revision
                            ? restoreInterruptedAttempt(current)
                            : undefined,
                    );
                    if (!restored?.changed)
                        throw Object.assign(new Error("the answered Work attempt changed"), {
                            code: ErrorCodes.InvalidState,
                        });
                } else if (
                    work.status !== "running" &&
                    work.status !== "completed" &&
                    !(work.status === "waiting" && work.waiting?.toolCallId !== toolCallId)
                ) {
                    throw Object.assign(
                        new Error("the answered Work attempt is no longer available"),
                        { code: ErrorCodes.InvalidState },
                    );
                }
                if (context && !context.attempt) await context.bind(bound);
                return work.status === "completed" || work.status === "waiting"
                    ? []
                    : [{ snapshot: work, attemptId: bound.attemptId }];
            }
            const expired = all.some(
                (work) =>
                    work.workspace === target.workspace &&
                    ((work.expiredInteraction?.sessionId === target.sessionId &&
                        work.expiredInteraction.toolCallId === toolCallId) ||
                        (work.invalidatedInteraction?.sessionId === target.sessionId &&
                            work.invalidatedInteraction.toolCallId === toolCallId)),
            );
            if (expired)
                throw Object.assign(
                    new Error("this Work interaction has expired or was cancelled"),
                    { code: ErrorCodes.InvalidState },
                );
            const waiting = all.filter(
                (work) =>
                    work.workspace === target.workspace &&
                    work.status === "waiting" &&
                    work.waiting?.sessionId === target.sessionId &&
                    work.waiting.toolCallId === toolCallId,
            );
            for (const snapshot of waiting) {
                const resumed = await this.controller.resumeAttempt(
                    snapshot.workId,
                    toolCallId,
                    context
                        ? {
                              workspace: target.workspace,
                              sessionId: target.sessionId,
                              lane: "main",
                              operationId: context.operationId,
                          }
                        : undefined,
                );
                if (resumed) {
                    const attemptId = resumed.attempt.attemptId;
                    if (context) {
                        await context.bind({ workId: resumed.workId, attemptId });
                    }
                    attempts.push({ snapshot, attemptId });
                } else
                    throw Object.assign(new Error("this Work interaction is no longer waiting"), {
                        code: ErrorCodes.InvalidState,
                    });
            }
        } catch (error) {
            if (context) throw error;
            if ((error as { code?: string }).code === ErrorCodes.InvalidState) throw error;
            log.error("could not record continuation start", { error: String(error) });
        }
        return attempts;
    }

    private async record(
        workId: string,
        update: () => Promise<unknown>,
        strict = false,
    ): Promise<void> {
        try {
            await update();
        } catch (error) {
            if (strict) throw error;
            log.error("could not record continuation outcome", { workId, error: String(error) });
        }
    }

    async answer(
        target: SessionTarget,
        toolCallId: string,
        run: () => Promise<AgentMessage>,
        context?: WorkAnswerContext,
    ): Promise<AgentMessage> {
        const attempts = await this.begin(target, toolCallId, context);
        let reply: AgentMessage;
        try {
            const first = attempts[0];
            reply =
                first && this.runWork
                    ? await this.runWork(first.snapshot.workId, target.sessionId, run)
                    : await run();
        } catch (error) {
            const partial = isAbortedTurn(error)
                ? await context?.readPartial?.().catch(() => "")
                : undefined;
            for (const { snapshot, attemptId } of attempts) {
                await this.record(
                    snapshot.workId,
                    () =>
                        isBusyError(error)
                            ? this.controller.restoreWaiting(snapshot, attemptId)
                            : this.controller.settle({
                                  workId: snapshot.workId,
                                  attemptId,
                                  outcome: isAbortedTurn(error) ? "aborted" : "error",
                                  resultText: partial ?? "",
                                  partial: !!partial,
                                  reason: error instanceof Error ? error.message : String(error),
                                  deliver: snapshot.kind === "inbound",
                                  parentWillReply: false,
                              }),
                    context !== undefined,
                );
            }
            throw error;
        }
        const waiting = resolveWaitingInteraction(reply, target.sessionId);
        for (const { snapshot, attemptId } of attempts) {
            await this.record(
                snapshot.workId,
                () =>
                    waiting
                        ? this.controller.waitForInput(snapshot.workId, waiting, attemptId)
                        : this.controller.settle({
                              workId: snapshot.workId,
                              attemptId,
                              outcome: "completed",
                              resultText:
                                  reply.role === "assistant"
                                      ? textBlocks(reply.content).join("\n")
                                      : "",
                              deliver: snapshot.kind === "inbound",
                              parentWillReply: false,
                          }),
                context !== undefined,
            );
        }
        return reply;
    }
}
