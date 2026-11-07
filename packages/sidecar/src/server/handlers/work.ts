/**
 * work.* handlers: the read-only overview of managed background work.
 *
 * Process-scoped, like jobs.*: a Work outlives the session that started it, so
 * nothing here needs a workspace runtime and nothing attaches a session. The
 * only write is `work.retryDelivery`, which re-sends a notice and never
 * re-runs the work.
 */

import type {
    WorkGetResult,
    WorkListResult,
    WorkRetryDeliveryResult,
    WorkSummary,
} from "@taco-ai/protocol";
import { registerMethod } from "../methodRegistry.ts";
import { SIDECAR_INSTANCE_ID } from "../push.ts";

export function registerWorkHandlers(): void {
    const legacy = (work: WorkSummary): WorkSummary =>
        work.status === "waiting"
            ? { ...work, status: "running", needsAttention: false, waiting: undefined }
            : work;
    const legacyList = (result: WorkListResult, supports: boolean): WorkListResult =>
        supports
            ? result
            : {
                  ...result,
                  active: result.active.map(legacy),
                  terminal: result.terminal.map(legacy),
              };
    registerMethod("workList", false, async ({ server, params }): Promise<WorkListResult> => {
        if (!server.work) {
            return { instanceId: SIDECAR_INSTANCE_ID, active: [], terminal: [] };
        }
        const result = await server.work.list({
            limit: params.limit,
            before: params.before,
            ...(params.jobId !== undefined ? { jobId: params.jobId } : {}),
        });
        return legacyList(result, server.supportsClientCapability?.("workWaiting") ?? true);
    });

    registerMethod("workGet", false, async ({ server, params }): Promise<WorkGetResult> => {
        if (!server.work) return { work: null };
        const result = await server.work.get(params.workId);
        if (server.supportsClientCapability?.("workWaiting") ?? true) return result;
        return result.work ? { ...result, work: legacy(result.work) } : result;
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
