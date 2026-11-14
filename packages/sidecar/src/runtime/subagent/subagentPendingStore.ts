import type { SessionId } from "@taco-ai/protocol";
import { KeyedQueue } from "../../store/serial.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import {
    addPendingSubagentResult,
    clearPendingSubagentResult,
    type PendingSubagentResult,
    readPendingSubagentResults,
} from "./subagentPending.ts";

/** Serializes durable pending notices and removes only the run that created one. */
export class SubagentPendingStore {
    private readonly queue = new KeyedQueue();

    constructor(private readonly registry: SessionRegistry) {}

    read(parentSessionId: SessionId): Promise<PendingSubagentResult[]> {
        return this.queue.run(String(parentSessionId), async () =>
            this.registry.withSession(parentSessionId, async (session) =>
                Object.values(await readPendingSubagentResults(session)),
            ),
        );
    }

    record(
        parentSessionId: SessionId,
        entry: PendingSubagentResult,
        onlyIfAbsent = false,
    ): Promise<void> {
        return this.queue.run(String(parentSessionId), async () =>
            this.registry.withSession(parentSessionId, async (session) => {
                const existing = await readPendingSubagentResults(session);
                if (onlyIfAbsent && entry.parentToolCallId in existing) return;
                await addPendingSubagentResult(session, entry);
            }),
        );
    }

    remove(
        parentSessionId: SessionId,
        entry: Pick<PendingSubagentResult, "parentToolCallId" | "runId" | "settledAt">,
    ): Promise<void> {
        return this.queue.run(String(parentSessionId), async () =>
            this.registry.withSession(parentSessionId, async (session) => {
                const existing = await readPendingSubagentResults(session);
                const current = existing[entry.parentToolCallId];
                if (!current) return;
                if (
                    current.runId !== entry.runId ||
                    (entry.runId === undefined && current.settledAt !== entry.settledAt)
                )
                    return;
                await clearPendingSubagentResult(session, entry.parentToolCallId);
            }),
        );
    }
}
