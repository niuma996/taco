import type { SessionId } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import type { BackgroundWorkSettlement } from "./workHooks.ts";
import type { WorkStore } from "./workStore.ts";
import type { WorkSettlementIntent } from "./workTypes.ts";

const log = createLogger("sidecar.work.settlementRecovery");

/** Replay finished attempts before operation recovery or orphan interruption. */
export async function recoverWorkSettlements(
    store: WorkStore,
    settle: (
        workId: string,
        parentSessionId: SessionId,
        intent: WorkSettlementIntent,
    ) => Promise<BackgroundWorkSettlement>,
): Promise<Set<string>> {
    const deferred = new Set<string>();
    for (const work of await store.list()) {
        try {
            const intent = await store.readSettlement(work.workId);
            if (!intent) continue;
            if (work.status !== "running" || work.attempt.attemptId !== intent.attemptId) {
                await store.clearSettlement(work.workId, intent.attemptId);
                continue;
            }
            const recovered = await settle(work.workId, work.parentSessionId as SessionId, intent);
            if (recovered.kind === "retry") deferred.add(work.workId);
        } catch (error) {
            deferred.add(work.workId);
            log.error("work settlement recovery failed", {
                workId: work.workId,
                error: String(error),
            });
        }
    }
    return deferred;
}
