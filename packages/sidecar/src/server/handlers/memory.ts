/**
 * memory.* handler — lets the desktop MemoryPane read and write the
 * memory subsystem.
 *
 * Key constraint: reuse MethodCtx.workspace.memoryStore; never `new`
 * a fresh instance. Writes must share the same writeChain as the
 * extractor — that shared chain is the whole reason this design holds.
 * Every method here is ensureWorkspace: true (workspace-scoped);
 * MethodCtx auto-injects the workspace.
 */

import type {
    MemoryDeleteTopicParams,
    MemoryDeleteTopicResult,
    MemoryDreamApplyParams,
    MemoryDreamApplyResult,
    MemoryDreamDiscardParams,
    MemoryDreamDiscardResult,
    MemoryDreamPreview,
    MemoryDreamReportSummary,
    MemoryDreamRunParams,
    MemoryDreamRunResult,
    MemoryDreamState,
    MemoryDreamUndoParams,
    MemoryDreamUndoResult,
    MemoryListParams,
    MemoryListResult,
    MemoryRestoreTopicParams,
    MemoryRestoreTopicResult,
    MemoryTopicEntry,
    MemoryUpsertParams,
    MemoryUpsertResult,
    MemoryWriteParams,
    MemoryWriteResult,
} from "@taco-ai/protocol";
import {
    ErrorCodes,
    MEMORY_CONTENT_MAX_CHARS,
    memoryDeleteTopicSchema,
    memoryDreamApplySchema,
    memoryDreamDiscardSchema,
    memoryDreamRunSchema,
    memoryDreamUndoSchema,
    memoryListSchema,
    memoryRestoreTopicSchema,
    memoryUpsertSchema,
    memoryWriteSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";

import {
    applyPendingDream,
    type DreamPendingPlan,
    type DreamReport,
    discardPendingDream,
    readPendingDream,
    runDream,
    undoDreamReport,
} from "../../memory/dream/consolidator.ts";
import type { DreamOptions } from "../../memory/dream/dreamPlan.ts";
import {
    listDreamReportIds,
    readDreamConfirmed,
    readDreamReport,
    readLastDreamAt,
} from "../../memory/dream/dreamState.ts";
import { hashOf, LocalMemoryStore } from "../../memory/local/store.ts";
import type { MemoryStore } from "../../memory/types.ts";
import { MemoryConflictError, normalizeMemoryTopicId } from "../../memory/types.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import {
    MEMORY_DREAM_JOB_ID,
    type MemoryDreamArgs,
    parseMemoryDreamArgs,
} from "../../scheduler/builtinJobs.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

/** Convert LocalMemoryStore's MemoryEntry to wire format. */
function toWireTopic(entry: {
    id: string;
    name: string;
    description: string;
    type: MemoryTopicEntry["type"];
    content: string;
    createdAt: string;
    updatedAt?: string;
}): MemoryTopicEntry {
    return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        type: entry.type,
        content: entry.content,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
    };
}

/**
 * Single deletion path shared by `memory.deleteTopic` (MemoryPane) and
 * `memory.upsert` action=remove (the model's `memory` tool). Both reach the
 * same store call; routing them through one helper keeps a future change
 * (audit log, cache invalidation) from landing on only one of them.
 */
async function deleteTopic(store: MemoryStore, id: string): Promise<void> {
    await store.deleteTopic(id);
}

/** Applied runs listed on `memory.list`; older reports stay on disk. */
const LISTED_REPORTS = 5;

function toReportSummary(report: DreamReport): MemoryDreamReportSummary {
    return {
        id: report.id,
        appliedAt: report.appliedAt,
        counts: report.counts,
        skipped: report.skipped.length,
        ...(report.undoneAt ? { undoneAt: report.undoneAt } : {}),
    };
}

/** Copy a stored plan into the wire shape (readonly arrays → mutable). */
function toWirePreview(plan: DreamPendingPlan): MemoryDreamPreview {
    return {
        id: plan.id,
        createdAt: plan.createdAt,
        actions: plan.actions.map((action) =>
            action.action === "merge"
                ? { ...action, sourceIds: [...action.sourceIds] }
                : { ...action },
        ),
        snapshot: { ...plan.snapshot },
        topicCount: plan.topicCount,
        counts: { ...plan.counts },
    };
}

/** The dream surface needs the file-backed store; memory off means no dream. */
function localStore(workspace: WorkspaceRuntime): LocalMemoryStore {
    const store = workspace.memoryStore;
    if (!(store instanceof LocalMemoryStore)) {
        throw new RpcHandlerError(ErrorCodes.InvalidParams, "memory is disabled");
    }
    return store;
}

function readDreamState(store: LocalMemoryStore): MemoryDreamState {
    const topicDir = store.topicDir;
    const lastAt = readLastDreamAt(topicDir);
    const pending = readPendingDream(store);
    return {
        ...(pending ? { pending: toWirePreview(pending) } : {}),
        confirmed: readDreamConfirmed(topicDir),
        ...(lastAt > 0 ? { lastRunAt: new Date(lastAt).toISOString() } : {}),
        reports: listDreamReportIds(topicDir)
            .slice(0, LISTED_REPORTS)
            .map((id) => readDreamReport<DreamReport>(topicDir, id))
            .filter((r): r is DreamReport => r !== undefined)
            .map(toReportSummary),
        archived: store.listArchivedTopics().map(toWireTopic),
    };
}

/** Surface a store/consolidator error as a conflict the UI can show. */
function asConflict(error: unknown): RpcHandlerError {
    if (error instanceof RpcHandlerError) return error;
    return new RpcHandlerError(
        ErrorCodes.InvalidParams,
        error instanceof Error ? error.message : String(error),
    );
}

export function registerMemoryHandlers(): void {
    registerMethod(
        RPC.memoryList,
        true,
        async ({ workspace, server }: MethodCtx<MemoryListParams>): Promise<MemoryListResult> => {
            const store = workspace.memoryStore;
            const content = store.readMemory();
            const dreamJob = server.jobs ? await server.jobs.get(MEMORY_DREAM_JOB_ID) : null;
            return {
                memoryContent: content,
                memoryHash: hashOf(content),
                topics: store.listTopics().map(toWireTopic),
                enabled: store.enabled,
                ...(store instanceof LocalMemoryStore ? { dream: readDreamState(store) } : {}),
                ...(dreamJob ? { dreamScheduled: dreamJob.enabled } : {}),
            };
        },
        { schema: memoryListSchema },
    );

    // Manual consolidation always previews, even for a confirmed workspace:
    // the user asked to see what dream would do, not to have it done.
    registerMethod(
        RPC.memoryDreamRun,
        true,
        async ({
            workspace,
            server,
        }: MethodCtx<MemoryDreamRunParams>): Promise<MemoryDreamRunResult> => {
            const store = localStore(workspace);
            const model = await resolveManualDreamModel(workspace, server);
            const outcome = await runDream(
                { store, models: model.models, model: model.model },
                { force: true, previewOnly: true, options: model.options },
            );
            if (outcome.status === "previewed") {
                return { status: "previewed", preview: toWirePreview(outcome.plan) };
            }
            if (outcome.status === "applied") {
                // previewOnly makes this unreachable; keep the type total.
                return { status: "skipped", reason: "applied" };
            }
            return { status: outcome.status, reason: outcome.reason };
        },
        { schema: memoryDreamRunSchema },
    );

    registerMethod(
        RPC.memoryDreamApply,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<MemoryDreamApplyParams>): Promise<MemoryDreamApplyResult> => {
            const store = localStore(workspace);
            const pending = readPendingDream(store);
            // The user reviewed one specific plan; a newer one must be reviewed too.
            if (!pending || pending.id !== params.previewId) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "the consolidation preview changed; review it again",
                );
            }
            try {
                return { report: toReportSummary(await applyPendingDream(store)) };
            } catch (error) {
                throw asConflict(error);
            }
        },
        { schema: memoryDreamApplySchema },
    );

    registerMethod(
        RPC.memoryDreamDiscard,
        true,
        async ({
            workspace,
        }: MethodCtx<MemoryDreamDiscardParams>): Promise<MemoryDreamDiscardResult> => {
            discardPendingDream(localStore(workspace));
            return { ok: true };
        },
        { schema: memoryDreamDiscardSchema },
    );

    registerMethod(
        RPC.memoryDreamUndo,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<MemoryDreamUndoParams>): Promise<MemoryDreamUndoResult> => {
            try {
                return { conflicts: await undoDreamReport(localStore(workspace), params.reportId) };
            } catch (error) {
                throw asConflict(error);
            }
        },
        { schema: memoryDreamUndoSchema },
    );

    registerMethod(
        RPC.memoryRestoreTopic,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<MemoryRestoreTopicParams>): Promise<MemoryRestoreTopicResult> => {
            try {
                await localStore(workspace).restoreTopic(params.id);
            } catch (error) {
                throw asConflict(error);
            }
            return { ok: true };
        },
        { schema: memoryRestoreTopicSchema },
    );

    registerMethod(
        RPC.memoryWrite,
        true,
        async ({ workspace, params }: MethodCtx<MemoryWriteParams>): Promise<MemoryWriteResult> => {
            try {
                await workspace.memoryStore.writeMemory(params.content, params.baseHash);
                return { ok: true };
            } catch (e) {
                if (e instanceof MemoryConflictError) {
                    throw new RpcHandlerError(
                        ErrorCodes.MemoryConflict,
                        "MEMORY.md changed on disk",
                        {
                            currentContent: e.currentContent,
                            currentHash: e.currentHash,
                        },
                    );
                }
                throw e;
            }
        },
        { schema: memoryWriteSchema },
    );

    registerMethod(
        RPC.memoryDeleteTopic,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<MemoryDeleteTopicParams>): Promise<MemoryDeleteTopicResult> => {
            await deleteTopic(workspace.memoryStore, params.id);
            return { ok: true };
        },
        { schema: memoryDeleteTopicSchema },
    );

    registerMethod(
        RPC.memoryUpsert,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<MemoryUpsertParams>): Promise<MemoryUpsertResult> => {
            // id whitelist: lowercase + kebab-case + length check. The
            // handler is the sole boundary.
            if (typeof params.id !== "string") {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "memory.upsert: id must be a string",
                );
            }
            const validatedId = normalizeMemoryTopicId(params.id);
            if (validatedId !== params.id || params.id.length > 64 || params.id.length === 0) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "memory.upsert: id must be kebab-case, ≤64 chars",
                );
            }
            const store = workspace.memoryStore;
            switch (params.action) {
                case "add": {
                    if (!params.name || !params.content || !params.type) {
                        throw new RpcHandlerError(
                            ErrorCodes.InvalidParams,
                            "memory.upsert add: name/content/type required",
                        );
                    }
                    if (
                        typeof params.name !== "string" ||
                        params.name.length > 60 ||
                        typeof params.content !== "string" ||
                        params.content.length > MEMORY_CONTENT_MAX_CHARS
                    ) {
                        throw new RpcHandlerError(
                            ErrorCodes.InvalidParams,
                            `memory.upsert add: name ≤60, content ≤${MEMORY_CONTENT_MAX_CHARS}`,
                        );
                    }
                    if (store.getTopic(validatedId)) {
                        throw new RpcHandlerError(
                            ErrorCodes.IdConflict,
                            `memory.upsert add: id "${validatedId}" already exists; use replace`,
                        );
                    }
                    await store.appendEntry({
                        id: validatedId,
                        name: params.name,
                        description: params.description ?? params.name,
                        type: params.type,
                        content: params.content,
                        createdAt: new Date().toISOString(),
                    });
                    return { ok: true, outcome: "created" };
                }
                case "replace": {
                    if (params.content === undefined) {
                        throw new RpcHandlerError(
                            ErrorCodes.InvalidParams,
                            "memory.upsert replace: content required",
                        );
                    }
                    await store.updateTopic(validatedId, params.content);
                    return { ok: true, outcome: "updated" };
                }
                case "remove": {
                    await deleteTopic(store, validatedId);
                    return { ok: true, outcome: "deleted" };
                }
                default: {
                    throw new RpcHandlerError(
                        ErrorCodes.InvalidParams,
                        `memory.upsert: unknown action "${(params as { action: string }).action}"`,
                    );
                }
            }
        },
        { schema: memoryUpsertSchema },
    );
}

/**
 * Model for a manual run: the scheduled job's `args.model` when set (so the
 * preview matches what the nightly run would do), else this workspace's
 * default model. Knobs come from the job's args too.
 */
async function resolveManualDreamModel(
    workspace: WorkspaceRuntime,
    server: MethodCtx<unknown>["server"],
): Promise<{
    models: WorkspaceRuntime["models"];
    model: NonNullable<WorkspaceRuntime["defaultModel"]>;
    options: Partial<DreamOptions>;
}> {
    const job = server.jobs ? await server.jobs.get(MEMORY_DREAM_JOB_ID) : null;
    const parsed = job ? parseMemoryDreamArgs(job.args) : undefined;
    const { model: override, ...options }: MemoryDreamArgs = parsed?.ok ? parsed.args : {};
    let model = workspace.defaultModel;
    if (override) {
        const slash = override.indexOf("/");
        const found =
            slash > 0
                ? workspace.models.getModel(override.slice(0, slash), override.slice(slash + 1))
                : workspace.models.getModels().find((m) => m.id === override);
        if (!found) {
            throw new RpcHandlerError(
                ErrorCodes.InvalidParams,
                `memory consolidation model not found: ${override}`,
            );
        }
        model = found as typeof model;
    }
    if (!model)
        throw new RpcHandlerError(
            ErrorCodes.InvalidParams,
            "no model available for memory consolidation",
        );
    return { models: workspace.models, model, options };
}
