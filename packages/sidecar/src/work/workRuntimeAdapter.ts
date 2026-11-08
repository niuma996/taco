import { laneState, operationResult } from "@taco-ai/pi-harness/harness/session";
import { type AgentMessage, asSessionId } from "@taco-ai/protocol";
import { harnessContext } from "../lib/harnessContext.ts";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";
import type { WorkOperationRuntime } from "./workOperationTypes.ts";

/** Reads persisted lane state through the session slot without creating a harness or recovery driver. */
export function workRuntimeAdapter(
    resolve: (workspace: string) => Promise<WorkspaceRuntime>,
): WorkOperationRuntime {
    return {
        inspect: async (ref) => {
            const workspace = await resolve(ref.workspace);
            return workspace.sessionRegistry.withSession(
                asSessionId(ref.sessionId),
                async (session) => {
                    const stored = (
                        await session.getValue(operationResult(ref.operationId), harnessContext)
                    )?.value;
                    if (stored) {
                        const tip = stored.tipId
                            ? await session.getEntry(stored.tipId, harnessContext)
                            : undefined;
                        return {
                            kind: "settled",
                            outcome:
                                stored.status === "completed"
                                    ? "completed"
                                    : stored.status === "aborted"
                                      ? "aborted"
                                      : "error",
                            message:
                                tip?.type === "message" ? (tip.message as AgentMessage) : undefined,
                            reason: stored.error?.message,
                        };
                    }
                    const state = (await session.getValue(laneState(ref.lane), harnessContext))
                        ?.value;
                    return {
                        kind: state?.currentOperationId === ref.operationId ? "open" : "missing",
                    };
                },
            );
        },
        abort: async (ref) => {
            const workspace = await resolve(ref.workspace);
            const attached = workspace.getAttached(asSessionId(ref.sessionId));
            if (!attached) return { outcome: "deferred", newlyRequested: false };
            return attached.requestOperationAbort(ref.operationId);
        },
    };
}
