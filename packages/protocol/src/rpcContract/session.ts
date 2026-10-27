/**
 * RPC contract rows — the bootstrap handshake plus session.* — lifecycle, reads, and turn control.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type { CommandPermissionResolveParams, CommandPermissionResolveResult } from "../config.js";

import type { InitializeParams, InitializeResult, SessionId } from "../frames.js";

import type { PlanStateUpdatedParams, TaskItem, TasksUpdatedParams } from "../push.js";
import {
    commandPermissionResolveSchema,
    initializeSchema,
    sessionAbortSchema,
    sessionAttachSchema,
    sessionCancelQueuedSchema,
    sessionCompactSchema,
    sessionContextInfoSchema,
    sessionCreateSchema,
    sessionDeleteSchema,
    sessionDetachSchema,
    sessionEventsGetSchema,
    sessionFollowUpSchema,
    sessionHistorySchema,
    sessionListModelsSchema,
    sessionListSchema,
    sessionPlanStateGetSchema,
    sessionPromptSchema,
    sessionRenameSchema,
    sessionSetModelSchema,
    sessionSetThinkingLevelSchema,
    sessionSnapshotGetSchema,
    sessionSteerSchema,
    sessionSubmitAnswersSchema,
    sessionTaskHistoryGetSchema,
    sessionTasksGetSchema,
    subagentAbortSchema,
} from "../schemas/index.js";
import type {
    AbortParams,
    AbortResult,
    CancelQueuedParams,
    CancelQueuedResult,
    CreateSessionParams,
    CreateSessionResult,
    DeleteSessionParams,
    FollowUpParams,
    FollowUpResult,
    ListModelsParams,
    PromptParams,
    PromptResult,
    RenameSessionParams,
    SessionAttachParams,
    SessionCompactParams,
    SessionCompactResult,
    SessionContextInfoParams,
    SessionContextInfoResult,
    SessionDetachParams,
    SessionEventsGetParams,
    SessionEventsGetResult,
    SessionHistory,
    SessionHistoryParams,
    SessionListParams,
    SessionListResult,
    SessionPlanStateGetParams,
    SessionSetThinkingLevelParams,
    SessionSnapshot,
    SessionSnapshotGetParams,
    SessionTaskHistoryGetParams,
    SessionTasksGetParams,
    SetModelParams,
    SteerParams,
    SteerResult,
    SubagentAbortParams,
    SubagentAbortResult,
} from "../session.js";
import type { SubmitAnswersParams } from "../tools.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

/** `session.attach` result — the attach acknowledgement plus live subagent state. */
export interface SessionAttachResult {
    attached: true;
    sessionId: SessionId;
    /**
     * parentToolCallIds whose subagent is running in the sidecar right now.
     * Absent on older sidecars. Process-memory state, so a fresh process
     * reports none — which is what lets a client expire agent tool cards
     * orphaned by a previous process exit without touching live ones.
     */
    inFlightAgentToolCallIds?: string[];
    /**
     * Child session ids under this parent that already produced a result
     * file. Unlike the list above this is read from disk, so it survives the
     * process that ran them — which is what separates a background child
     * that finished from one a previous process was killed mid-run. Absent
     * on older sidecars.
     */
    settledBackgroundSubSessionIds?: string[];
}

/** `session.detach` result. */
export interface SessionDetachResult {
    detached: true;
}

/** `session.delete` result. */
export interface SessionDeleteResult {
    deleted: true;
}

/** `session.rename` result. */
export interface SessionRenameResult {
    renamed: true;
}

/** `session.setModel` result. */
export interface SessionSetModelResult {
    switchedTo: { provider: string; modelId: string };
}

/** `session.setThinkingLevel` result. */
export interface SessionSetThinkingLevelResult {
    level: SessionSetThinkingLevelParams["level"];
}

/** `session.listModels` result. */
export interface SessionListModelsResult {
    models: Array<{ provider: string; id: string; name?: string }>;
}

/** `session.taskHistory.get` result — the expanded item list for one history list. */
export type SessionTaskHistoryGetResult = TaskItem[];

/** `session.tasks.get` result — the current task list snapshot. */
export type SessionTasksGetResult = Pick<TasksUpdatedParams, "active" | "history">;

/** `session.planState.get` result — the current plan-mode state. */
export type SessionPlanStateGetResult = Pick<PlanStateUpdatedParams, "active" | "currentSlug">;

const sessionRows = {
    initialize: row<InitializeParams, InitializeResult>()(
        "initialize",
        "process",
        initializeSchema,
    ),
    sessionList: row<SessionListParams, SessionListResult>()(
        "session.list",
        "workspace",
        sessionListSchema,
    ),
    sessionCreate: row<CreateSessionParams, CreateSessionResult>()(
        "session.create",
        "workspace",
        sessionCreateSchema,
    ),
    sessionAttach: row<SessionAttachParams, SessionAttachResult>()(
        "session.attach",
        "workspace",
        sessionAttachSchema,
    ),
    sessionDetach: row<SessionDetachParams, SessionDetachResult>()(
        "session.detach",
        "workspace",
        sessionDetachSchema,
    ),
    sessionDelete: row<DeleteSessionParams, SessionDeleteResult>()(
        "session.delete",
        "workspace",
        sessionDeleteSchema,
    ),
    sessionRename: row<RenameSessionParams, SessionRenameResult>()(
        "session.rename",
        "workspace",
        sessionRenameSchema,
    ),
    sessionHistory: row<SessionHistoryParams, SessionHistory>()(
        "session.history",
        "workspace",
        sessionHistorySchema,
    ),
    sessionEventsGet: row<SessionEventsGetParams, SessionEventsGetResult>()(
        "session.events.get",
        "workspace",
        sessionEventsGetSchema,
    ),
    sessionSnapshotGet: row<SessionSnapshotGetParams, SessionSnapshot>()(
        "session.snapshot.get",
        "workspace",
        sessionSnapshotGetSchema,
    ),
    sessionTasksGet: row<SessionTasksGetParams, SessionTasksGetResult>()(
        "session.tasks.get",
        "workspace",
        sessionTasksGetSchema,
    ),
    sessionTaskHistoryGet: row<SessionTaskHistoryGetParams, SessionTaskHistoryGetResult>()(
        "session.taskHistory.get",
        "workspace",
        sessionTaskHistoryGetSchema,
    ),
    sessionPlanStateGet: row<SessionPlanStateGetParams, SessionPlanStateGetResult>()(
        "session.planState.get",
        "workspace",
        sessionPlanStateGetSchema,
    ),
    sessionPrompt: row<PromptParams, PromptResult>()(
        "session.prompt",
        "workspace",
        sessionPromptSchema,
    ),
    sessionSteer: row<SteerParams, SteerResult>()("session.steer", "workspace", sessionSteerSchema),
    sessionFollowUp: row<FollowUpParams, FollowUpResult>()(
        "session.followUp",
        "workspace",
        sessionFollowUpSchema,
    ),
    sessionCancelQueued: row<CancelQueuedParams, CancelQueuedResult>()(
        "session.cancelQueued",
        "workspace",
        sessionCancelQueuedSchema,
    ),
    sessionAbort: row<AbortParams, AbortResult>()("session.abort", "workspace", sessionAbortSchema),
    subagentAbort: row<SubagentAbortParams, SubagentAbortResult>()(
        "subagent.abort",
        "workspace",
        subagentAbortSchema,
    ),
    commandPermissionResolve: row<CommandPermissionResolveParams, CommandPermissionResolveResult>()(
        "commandPermission.resolve",
        "workspace",
        commandPermissionResolveSchema,
    ),
    sessionSetModel: row<SetModelParams, SessionSetModelResult>()(
        "session.setModel",
        "workspace",
        sessionSetModelSchema,
    ),
    sessionListModels: row<ListModelsParams, SessionListModelsResult>()(
        "session.listModels",
        "workspace",
        sessionListModelsSchema,
    ),
    sessionSetThinkingLevel: row<SessionSetThinkingLevelParams, SessionSetThinkingLevelResult>()(
        "session.setThinkingLevel",
        "workspace",
        sessionSetThinkingLevelSchema,
    ),
    sessionCompact: row<SessionCompactParams, SessionCompactResult>()(
        "session.compact",
        "workspace",
        sessionCompactSchema,
    ),
    sessionContextInfo: row<SessionContextInfoParams, SessionContextInfoResult>()(
        "session.contextInfo",
        "workspace",
        sessionContextInfoSchema,
    ),
    sessionSubmitAnswers: row<SubmitAnswersParams, null>()(
        "session.submitAnswers",
        "workspace",
        sessionSubmitAnswersSchema,
    ),
};

export const sessionMethods = domainMethods(sessionRows);
export const sessionContract = domainContract(sessionRows);
export const sessionSchemas = domainSchemas(sessionRows);
