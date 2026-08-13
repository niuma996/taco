/**
 * session.* read handlers — events, history, snapshot, tasks, planState.
 *
 * Pure pull side: these handlers only read session state and never
 * interact with the harness turn loop.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
    AttachParams,
    SessionEventsGetParams,
    SessionHistory,
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
                    timestamp: e.timestamp,
                },
            ];
        }
        return [
            {
                id: e.id,
                parentId: e.parentId,
                type: e.type,
                payload,
                timestamp: e.timestamp,
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
    const exact = sessions.find((candidate) => candidate.id === sessionId);
    const matches = exact
        ? [exact]
        : sessions.filter((candidate) => candidate.id.startsWith(sessionId));
    if (matches.length > 1) {
        throw new RpcHandlerError(
            ErrorCodes.InvalidParams,
            `session id prefix is ambiguous: ${sessionId}`,
        );
    }
    const session = matches[0];
    const metadata = session?.metadata as Record<string, unknown> | undefined;
    return metadata?.kind === "subagent" ? "subagent" : "main";
}

export function registerSessionReadHandlers(): void {
    registerMethod(
        RPC.sessionEventsGet,
        true,
        ({ server, params }: MethodCtx<SessionEventsGetParams>) => {
            if (!Number.isInteger(params.afterSeq) || params.afterSeq < 0) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "afterSeq must be a non-negative integer",
                );
            }
            return Promise.resolve(
                server.getSessionEvents(params.workspace, params.sessionId, params.afterSeq),
            );
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
