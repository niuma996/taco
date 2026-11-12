/**
 * session.* read handlers — events, history, snapshot, tasks, planState.
 *
 * Pure pull side: these handlers only read session state and never
 * interact with the harness turn loop.
 */

import type {
    AttachParams,
    SessionHistory,
    SessionId,
    SessionSnapshot,
    SubagentStartedPayload,
} from "@taco-ai/protocol";
import { ErrorCodes } from "@taco-ai/protocol";
import { viewUserContent } from "../../attachments/userMessageView.ts";
import type { AttachedSession } from "../../runtime/harness/attachedSession.ts";
import { toSessionRuntimeSnapshot } from "../../runtime/harness/sessionRuntimeSnapshot.ts";
import type { ImageContent, TextContent } from "../../runtime/pi/types.ts";
import { resolveSessionByPrefix } from "../../runtime/session/sessionLookup.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import { rehydrateAskUserDetails } from "../../tags/index.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { ensureAttached } from "./attachGuard.ts";
import { buildHistoryListDetail, buildTasksGetResult } from "./sessionTasksGet.ts";

function toSessionHistory(
    sessionId: AttachParams["sessionId"],
    hist: Awaited<ReturnType<WorkspaceRuntime["getHistory"]>>,
): SessionHistory {
    type Payload = (typeof hist.entries)[number] extends { message?: infer M } ? M : unknown;
    const hydrated = rehydrateAskUserDetails(hist.entries);
    const entries = hydrated.flatMap((e) => {
        const payload = e.type === "message" && "message" in e ? e.message : e;
        const msg = payload as
            | { role?: unknown; content?: string | (TextContent | ImageContent)[] }
            | undefined;
        if (msg && msg.role === "user" && msg.content !== undefined) {
            const view = viewUserContent(msg.content);
            if (view.empty) return [];
            return [
                {
                    id: e.id,
                    parentId: e.parentId,
                    type: e.type,
                    payload: {
                        ...msg,
                        content: view.content,
                        ...(view.attachments.length > 0 ? { attachments: view.attachments } : {}),
                    } as Payload,
                    // pi 0.85 stores epoch millis; the wire contract is an ISO string.
                    timestamp: new Date(e.timestamp).toISOString(),
                },
            ];
        }
        return [
            {
                id: e.id,
                parentId: e.parentId,
                type: e.type,
                payload,
                // pi 0.85 stores epoch millis; the wire contract is an ISO string.
                timestamp: new Date(e.timestamp).toISOString(),
            },
        ];
    });
    return { sessionId, leafEntryId: hist.leafEntryId, entries };
}

async function getPersistedSessionKind(
    workspace: WorkspaceRuntime,
    sessionId: AttachParams["sessionId"],
): Promise<"main" | "subagent"> {
    const sessions = await workspace.listSessions();
    // Shared with SessionRegistry.openSession — same "exact id, or the one
    // session whose id starts with this prefix" resolution, so a caller cannot
    // get one answer here and a different one from an attach.
    const resolution = resolveSessionByPrefix(sessions, sessionId);
    if (resolution.kind === "ambiguous") {
        throw new RpcHandlerError(
            ErrorCodes.InvalidParams,
            `session id prefix is ambiguous: ${sessionId}`,
        );
    }
    if (resolution.kind === "not_found") return "main";
    // The kind is a taco fact in the session's value store; pi 0.85 removed the
    // free-form metadata bag that used to carry it. An unreadable session is
    // treated as "main" rather than failing the request.
    const facts = await workspace
        .getSessionFacts(resolution.meta.id as SessionId)
        .catch(() => undefined);
    return facts?.kind === "subagent" ? "subagent" : "main";
}

export function registerSessionReadHandlers(): void {
    registerMethod("sessionEventsGet", true, async ({ server, params }) => {
        if (!Number.isInteger(params.afterSeq) || params.afterSeq < 0) {
            throw new RpcHandlerError(
                ErrorCodes.InvalidParams,
                "afterSeq must be a non-negative integer",
            );
        }
        // A client replaying across a sidecar restart may reach this
        // before any attach — hydrate so the ring reflects the disk tail.
        await server.hydrateSessionEvents(params.workspace, params.sessionId);
        return server.getSessionEvents(params.workspace, params.sessionId, params.afterSeq);
    });

    registerMethod("sessionHistory", true, async ({ workspace, params }) => {
        return toSessionHistory(params.sessionId, await workspace.getHistory(params.sessionId));
    });

    registerMethod("sessionSnapshotGet", true, async ({ workspace, params, server }) => {
        const sessionKind = await getPersistedSessionKind(workspace, params.sessionId);
        // Same restart-window reasoning as sessionEventsGet: lastSeq feeds
        // snapshotSeq, so the ring must know about the disk tail first or
        // the client would adopt snapshotSeq=0 and re-recover on every push.
        await server.hydrateSessionEvents(params.workspace, params.sessionId);
        // Snapshot reads are passive. An attached lane supplies live runtime
        // state; an unattached session remains history-only until an explicit
        // session.attach starts recovery.
        const attached = workspace.getAttached?.(params.sessionId);
        for (let attempt = 0; attempt < 3; attempt++) {
            const beforeSeq = server.getSessionLastSeq(params.workspace, params.sessionId);
            let watch: Awaited<ReturnType<AttachedSession["watchSnapshot"]>> | undefined;
            let changed = false;
            try {
                watch = await attached?.watchSnapshot?.();
                watch?.start(() => {
                    changed = true;
                });
                const source = watch ? structuredClone(watch.snapshot) : undefined;
                // Lane snapshots stop at the latest compaction. Keep the
                // existing full-history contract when that boundary is present.
                const historySource =
                    !source || source.transcript[0]?.type === "compaction"
                        ? await workspace.getHistory(params.sessionId)
                        : { leafEntryId: source.tipId, entries: source.transcript };
                if (source && historySource.leafEntryId !== source.tipId) changed = true;
                const history = toSessionHistory(params.sessionId, historySource);
                let runtime: SessionSnapshot["runtime"];
                if (source) {
                    const settledBackgroundSubSessionIds =
                        await workspace.settledBackgroundSubSessionIds(params.sessionId);
                    runtime = toSessionRuntimeSnapshot(
                        { ...source, transcript: historySource.entries },
                        {
                            settledBackgroundSubSessionIds,
                            inFlightAgentToolCallIds: workspace.inFlightAgentToolCallIds(
                                params.sessionId,
                            ),
                            pendingCommandPermissions: workspace.permissionBroker.pendingForSession(
                                params.sessionId,
                            ),
                        },
                    );
                    const activeSubagentChatRuns = (
                        workspace as {
                            activeSubagentChatRuns?: (sid: SessionId) => SubagentStartedPayload[];
                        }
                    ).activeSubagentChatRuns?.(params.sessionId);
                    if (activeSubagentChatRuns !== undefined)
                        runtime.activeSubagentChatRuns = activeSubagentChatRuns;
                }
                const tasks =
                    sessionKind === "main" && attached
                        ? buildTasksGetResult(attached.taskStore)
                        : undefined;
                const planState =
                    sessionKind === "main" && attached
                        ? {
                              active: attached.planState.active,
                              currentSlug: attached.planState.currentSlug,
                          }
                        : undefined;
                const afterSeq = server.getSessionLastSeq(params.workspace, params.sessionId);
                if (!changed && beforeSeq === afterSeq) {
                    return {
                        sessionId: params.sessionId,
                        sessionKind,
                        snapshotSeq: afterSeq,
                        history,
                        ...(runtime ? { runtime } : {}),
                        ...(tasks ? { tasks } : {}),
                        ...(planState ? { planState } : {}),
                    } satisfies SessionSnapshot;
                }
            } finally {
                watch?.unsubscribe();
            }
        }
        throw new RpcHandlerError(
            ErrorCodes.SnapshotUnstable,
            "session changed while building snapshot; retry recovery",
        );
    });

    registerMethod("sessionTasksGet", true, async ({ workspace, params }) => {
        const attached = await ensureAttached(workspace, params.sessionId);
        return buildTasksGetResult(attached.taskStore);
    });

    registerMethod("sessionPlanStateGet", true, async ({ workspace, params }) => {
        const attached = await ensureAttached(workspace, params.sessionId);
        return {
            active: attached.planState.active,
            currentSlug: attached.planState.currentSlug,
        };
    });

    registerMethod(
        "sessionTaskHistoryGet",
        true,
        async ({ workspace, params }: MethodCtx<AttachParams & { listId: string }>) => {
            const attached = await ensureAttached(workspace, params.sessionId);
            return buildHistoryListDetail(attached.taskStore, params.listId);
        },
    );
}
