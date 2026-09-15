/**
 * session.* read handlers — events, history, snapshot, tasks, planState.
 *
 * Pure pull side: these handlers only read session state and never
 * interact with the harness turn loop.
 */

import type {
    AttachParams,
    SessionEventsGetParams,
    SessionHistory,
    SessionId,
    SessionSnapshot,
    SessionSnapshotGetParams,
} from "@taco-ai/protocol";
import {
    ErrorCodes,
    sessionEventsGetSchema,
    sessionHistorySchema,
    sessionPlanStateGetSchema,
    sessionSnapshotGetSchema,
    sessionTaskHistoryGetSchema,
    sessionTasksGetSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import type { ImageContent, TextContent } from "../../runtime/pi/types.ts";

import { resolveSessionByPrefix } from "../../runtime/session/sessionLookup.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import {
    applyTuiVisibilityToContent,
    isContentEmptyAfterVisibility,
    rehydrateAskUserDetails,
} from "../../tags/index.ts";
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
            const content = applyTuiVisibilityToContent(msg.content);
            if (isContentEmptyAfterVisibility(content)) return [];
            return [
                {
                    id: e.id,
                    parentId: e.parentId,
                    type: e.type,
                    payload: { ...msg, content } as Payload,
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
    registerMethod(
        RPC.sessionEventsGet,
        true,
        async ({ server, params }: MethodCtx<SessionEventsGetParams>) => {
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
        },
        { schema: sessionEventsGetSchema },
    );

    registerMethod(
        RPC.sessionHistory,
        true,
        async ({ workspace, params }: MethodCtx<AttachParams>) => {
            return toSessionHistory(params.sessionId, await workspace.getHistory(params.sessionId));
        },
        { schema: sessionHistorySchema },
    );

    registerMethod(
        RPC.sessionSnapshotGet,
        true,
        async ({ workspace, params, server }: MethodCtx<SessionSnapshotGetParams>) => {
            const sessionKind = await getPersistedSessionKind(workspace, params.sessionId);
            // Same restart-window reasoning as sessionEventsGet: lastSeq feeds
            // snapshotSeq, so the ring must know about the disk tail first or
            // the client would adopt snapshotSeq=0 and re-recover on every push.
            await server.hydrateSessionEvents(params.workspace, params.sessionId);
            for (let attempt = 0; attempt < 3; attempt++) {
                const beforeSeq = server.getSessionLastSeq(params.workspace, params.sessionId);
                const history = toSessionHistory(
                    params.sessionId,
                    await workspace.getHistory(params.sessionId),
                );
                let tasks: SessionSnapshot["tasks"];
                let planState: SessionSnapshot["planState"];
                if (sessionKind === "main") {
                    const attached = await ensureAttached(workspace, params.sessionId);
                    tasks = buildTasksGetResult(attached.taskStore);
                    planState = {
                        active: attached.planState.active,
                        currentSlug: attached.planState.currentSlug,
                    };
                }
                const afterSeq = server.getSessionLastSeq(params.workspace, params.sessionId);
                if (beforeSeq === afterSeq) {
                    return {
                        sessionId: params.sessionId,
                        sessionKind,
                        snapshotSeq: afterSeq,
                        history,
                        ...(tasks ? { tasks } : {}),
                        ...(planState ? { planState } : {}),
                    } satisfies SessionSnapshot;
                }
            }
            throw new RpcHandlerError(
                ErrorCodes.SnapshotUnstable,
                "session changed while building snapshot; retry recovery",
            );
        },
        { schema: sessionSnapshotGetSchema },
    );

    registerMethod(
        RPC.sessionTasksGet,
        true,
        async ({ workspace, params }: MethodCtx<AttachParams>) => {
            const attached = await ensureAttached(workspace, params.sessionId);
            return buildTasksGetResult(attached.taskStore);
        },
        { schema: sessionTasksGetSchema },
    );

    registerMethod(
        RPC.sessionPlanStateGet,
        true,
        async ({ workspace, params }: MethodCtx<AttachParams>) => {
            const attached = await ensureAttached(workspace, params.sessionId);
            return {
                active: attached.planState.active,
                currentSlug: attached.planState.currentSlug,
            };
        },
        { schema: sessionPlanStateGetSchema },
    );

    registerMethod(
        RPC.sessionTaskHistoryGet,
        true,
        async ({ workspace, params }: MethodCtx<AttachParams & { listId: string }>) => {
            const attached = await ensureAttached(workspace, params.sessionId);
            return buildHistoryListDetail(attached.taskStore, params.listId);
        },
        { schema: sessionTaskHistoryGetSchema },
    );
}
