/**
 * work.* handlers: the read-only overview of managed background work.
 *
 * Process-scoped, like jobs.*: a Work outlives the session that started it, so
 * nothing here needs a workspace runtime and nothing attaches a session. The
 * only write is `work.retryDelivery`, which re-sends a notice and never
 * re-runs the work.
 */

import type { WorkGetResult, WorkListResult, WorkRetryDeliveryResult } from "@taco-ai/protocol";
import { registerMethod } from "../methodRegistry.ts";
import { SIDECAR_INSTANCE_ID } from "../push.ts";

export function registerWorkHandlers(): void {
    registerMethod("workList", false, async ({ server, params }): Promise<WorkListResult> => {
        if (!server.work) {
            return { instanceId: SIDECAR_INSTANCE_ID, active: [], terminal: [] };
        }
        return server.work.list({ limit: params.limit, before: params.before });
    });

    registerMethod("workGet", false, async ({ server, params }): Promise<WorkGetResult> => {
        if (!server.work) return { work: null };
        return server.work.get(params.workId);
    });

    registerMethod(
        "workRetryDelivery",
        false,
        async ({ server, params }): Promise<WorkRetryDeliveryResult> => {
            if (!server.work) return { outcome: "not_found" };
            return server.work.retryDelivery(params.workId);
        },
    );
}
