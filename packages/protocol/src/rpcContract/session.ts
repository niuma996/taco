/**
 * RPC contract rows — the bootstrap handshake plus session.* — lifecycle, reads, and turn control.
 *
 * Three tables move together: the wire name, the params/result types, and the
 * params schema. `rpcContract/index.ts` merges them into the single
 * `RPC` / `rpcContract` / `rpcSchemas` exports that the client and the
 * sidecar both read.
 *
 * Adding a method to this domain means adding one entry to each of the three
 * tables below — the compile-time assertions in the index catch a row that
 * was added to one and forgotten in another.
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
import type { RpcContractRow } from "./types.js";

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

/** Wire names for this domain. */
export const sessionMethods = {
    initialize: "initialize",
    // workspace.*
    sessionList: "session.list",
    sessionCreate: "session.create",
    sessionAttach: "session.attach",
    sessionDetach: "session.detach",
    sessionDelete: "session.delete",
    sessionRename: "session.rename",
    sessionHistory: "session.history",
    sessionEventsGet: "session.events.get",
    sessionSnapshotGet: "session.snapshot.get",
    sessionTasksGet: "session.tasks.get",
    /** Fetch the full task list for a given history list (history pushes meta only; expand on demand). */
    sessionTaskHistoryGet: "session.taskHistory.get",
    sessionPlanStateGet: "session.planState.get",
    sessionPrompt: "session.prompt",
    sessionSteer: "session.steer",
    /** Like steer, but consumed only at may-finish boundaries. */
    sessionFollowUp: "session.followUp",
    /** Remove one not-yet-consumed queue entry (steer/followUp/nextRun). */
    sessionCancelQueued: "session.cancelQueued",
    sessionAbort: "session.abort",
    /** Stop one running subagent (by child session id) without aborting the parent's turn. */
    subagentAbort: "subagent.abort",
    commandPermissionResolve: "commandPermission.resolve",
    sessionSetModel: "session.setModel",
    sessionListModels: "session.listModels",
    /** List the availability view of built-in providers (configured + models) for the Model settings UI. */
    sessionSetThinkingLevel: "session.setThinkingLevel",
    sessionCompact: "session.compact",
    sessionContextInfo: "session.contextInfo",
    /** Submit askUser answers — sidecar injects <ask_user_context> into the user message; clients don't see the wire format. */
    sessionSubmitAnswers: "session.submitAnswers",
    /** Pull model ids from a provider's /models endpoint for the settings model list. */
} as const;

/** Params/result types and routing scope for this domain. */
export const sessionContract = {
    initialize: { scope: "process" } as RpcContractRow<InitializeParams, InitializeResult>,
    sessionList: { scope: "workspace" } as RpcContractRow<SessionListParams, SessionListResult>,
    sessionCreate: { scope: "workspace" } as RpcContractRow<
        CreateSessionParams,
        CreateSessionResult
    >,
    sessionAttach: { scope: "workspace" } as RpcContractRow<
        SessionAttachParams,
        SessionAttachResult
    >,
    sessionDetach: { scope: "workspace" } as RpcContractRow<
        SessionDetachParams,
        SessionDetachResult
    >,
    sessionDelete: { scope: "workspace" } as RpcContractRow<
        DeleteSessionParams,
        SessionDeleteResult
    >,
    sessionRename: { scope: "workspace" } as RpcContractRow<
        RenameSessionParams,
        SessionRenameResult
    >,
    sessionHistory: { scope: "workspace" } as RpcContractRow<SessionHistoryParams, SessionHistory>,
    sessionEventsGet: { scope: "workspace" } as RpcContractRow<
        SessionEventsGetParams,
        SessionEventsGetResult
    >,
    sessionSnapshotGet: { scope: "workspace" } as RpcContractRow<
        SessionSnapshotGetParams,
        SessionSnapshot
    >,
    sessionTasksGet: { scope: "workspace" } as RpcContractRow<
        SessionTasksGetParams,
        SessionTasksGetResult
    >,
    sessionTaskHistoryGet: { scope: "workspace" } as RpcContractRow<
        SessionTaskHistoryGetParams,
        SessionTaskHistoryGetResult
    >,
    sessionPlanStateGet: { scope: "workspace" } as RpcContractRow<
        SessionPlanStateGetParams,
        SessionPlanStateGetResult
    >,
    sessionPrompt: { scope: "workspace" } as RpcContractRow<PromptParams, PromptResult>,
    sessionSteer: { scope: "workspace" } as RpcContractRow<SteerParams, SteerResult>,
    sessionFollowUp: { scope: "workspace" } as RpcContractRow<FollowUpParams, FollowUpResult>,
    sessionCancelQueued: { scope: "workspace" } as RpcContractRow<
        CancelQueuedParams,
        CancelQueuedResult
    >,
    sessionSubmitAnswers: { scope: "workspace" } as RpcContractRow<SubmitAnswersParams, null>,
    sessionAbort: { scope: "workspace" } as RpcContractRow<AbortParams, AbortResult>,
    subagentAbort: { scope: "workspace" } as RpcContractRow<
        SubagentAbortParams,
        SubagentAbortResult
    >,
    sessionSetModel: { scope: "workspace" } as RpcContractRow<
        SetModelParams,
        SessionSetModelResult
    >,
    sessionSetThinkingLevel: { scope: "workspace" } as RpcContractRow<
        SessionSetThinkingLevelParams,
        SessionSetThinkingLevelResult
    >,
    sessionListModels: { scope: "workspace" } as RpcContractRow<
        ListModelsParams,
        SessionListModelsResult
    >,
    sessionCompact: { scope: "workspace" } as RpcContractRow<
        SessionCompactParams,
        SessionCompactResult
    >,
    sessionContextInfo: { scope: "workspace" } as RpcContractRow<
        SessionContextInfoParams,
        SessionContextInfoResult
    >,
    commandPermissionResolve: { scope: "workspace" } as RpcContractRow<
        CommandPermissionResolveParams,
        CommandPermissionResolveResult
    >,
};

/** Params schemas for this domain. */
export const sessionSchemas = {
    initialize: initializeSchema,
    sessionList: sessionListSchema,
    sessionCreate: sessionCreateSchema,
    sessionAttach: sessionAttachSchema,
    sessionDetach: sessionDetachSchema,
    sessionDelete: sessionDeleteSchema,
    sessionRename: sessionRenameSchema,
    sessionHistory: sessionHistorySchema,
    sessionEventsGet: sessionEventsGetSchema,
    sessionSnapshotGet: sessionSnapshotGetSchema,
    sessionTasksGet: sessionTasksGetSchema,
    sessionTaskHistoryGet: sessionTaskHistoryGetSchema,
    sessionPlanStateGet: sessionPlanStateGetSchema,
    sessionPrompt: sessionPromptSchema,
    sessionSteer: sessionSteerSchema,
    sessionFollowUp: sessionFollowUpSchema,
    sessionCancelQueued: sessionCancelQueuedSchema,
    sessionSubmitAnswers: sessionSubmitAnswersSchema,
    sessionAbort: sessionAbortSchema,
    subagentAbort: subagentAbortSchema,
    sessionSetModel: sessionSetModelSchema,
    sessionSetThinkingLevel: sessionSetThinkingLevelSchema,
    sessionListModels: sessionListModelsSchema,
    sessionCompact: sessionCompactSchema,
    sessionContextInfo: sessionContextInfoSchema,
    commandPermissionResolve: commandPermissionResolveSchema,
};
