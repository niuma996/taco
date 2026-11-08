import { createHash } from "node:crypto";
import { harnessContext } from "../../lib/harnessContext.ts";
import { isBusyError } from "../harness/harnessErrors.ts";
import type { Session } from "../pi/types.ts";
import { value } from "../pi/values.ts";

interface AnswerReceipt {
    version: 1;
    payloadHash: string;
    operationId: string;
    text: string;
    status: "prepared" | "completed";
    work?: { workId: string; attemptId: string };
}

interface AnswerSubmission {
    toolCallId: string;
    toolName: string;
    answers: Record<string, string | string[]>;
}

interface PendingAnswer {
    payloadHash: string;
    promise: Promise<void>;
}

// Serialize receipt creation before the first durable write, including clients
// that retry with a new commandId. Entries live only as long as the submission.
const pending = new WeakMap<Session, Map<string, PendingAnswer>>();

/** The interaction already has a different submitted payload. */
export class AnswerReceiptConflict extends Error {
    constructor() {
        super("different answers have already been submitted for this interaction");
    }
}

/**
 * Persist an answer's identity before prompting. Prepared receipts replay the
 * same operation; only a successful run may acknowledge a completed receipt.
 * The caller must never accept an ended operationId as a new operation.
 */
export function withAnswerReceipt(
    session: Session,
    submission: AnswerSubmission,
    prepare: (answers: AnswerSubmission["answers"]) => Promise<string>,
    run: (
        receipt: Readonly<AnswerReceipt>,
        bind: (handle: { workId: string; attemptId: string }) => Promise<void>,
    ) => Promise<unknown>,
): Promise<void> {
    const answers = Object.fromEntries(
        Object.keys(submission.answers)
            .sort()
            .map((key) => {
                const answer = submission.answers[key];
                return [key, Array.isArray(answer) ? [...answer] : answer];
            }),
    );
    const payloadHash = createHash("sha256").update(JSON.stringify(answers)).digest("hex");
    const key = JSON.stringify([submission.toolName, submission.toolCallId]);
    let entries = pending.get(session);
    if (!entries) {
        entries = new Map();
        pending.set(session, entries);
    }
    const active = entries.get(key);
    if (active) {
        return active.payloadHash === payloadHash
            ? active.promise
            : Promise.reject(new AnswerReceiptConflict());
    }

    const address = value<AnswerReceipt>("taco.session.answerReceipt", key);
    const execute = async () => {
        let receipt = (await session.getValue(address, harnessContext))?.value;
        if (receipt && receipt.payloadHash !== payloadHash) throw new AnswerReceiptConflict();
        if (receipt?.status === "completed") return;
        if (!receipt) {
            receipt = {
                version: 1,
                payloadHash,
                operationId: session.idGenerator.next(Date.now()),
                text: await prepare(answers),
                status: "prepared",
            };
            await session.setValue(address, receipt, harnessContext);
        }

        let prepared = receipt;
        const bind = async (work: { workId: string; attemptId: string }) => {
            const next = { ...prepared, work: { ...work } };
            await session.setValue(address, next, harnessContext);
            prepared = next;
        };
        try {
            await run(prepared, bind);
        } catch (error) {
            // LaneBusy refuses admission: no user message was consumed, so a
            // subsequent submission may choose a different answer.
            if (isBusyError(error)) await session.deleteValue(address, harnessContext);
            throw error;
        }
        await session.setValue(address, { ...prepared, status: "completed" }, harnessContext);
    };
    const promise = execute().finally(() => entries.delete(key));
    entries.set(key, { payloadHash, promise });
    return promise;
}
