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
    MemoryDeleteTopicResult,
    MemoryDreamApplyResult,
    MemoryDreamDiscardResult,
    MemoryDreamPreview,
    MemoryDreamReportSummary,
    MemoryDreamRunResult,
    MemoryDreamState,
    MemoryDreamUndoResult,
    MemoryListResult,
    MemoryRestoreTopicResult,
    MemoryTopicEntry,
    MemoryUpsertResult,
    MemoryWriteResult,
} from "@taco-ai/protocol";
import { ErrorCodes, MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";

import {
    applyPendingDream,
    type DreamPendingPlan,
    type DreamReport,
    discardPendingDream,
    readPendingDream,
    runDream,
    undoDreamReport,
} from "../../memory/dream/consolidator.ts";
import { resolveDreamModel } from "../../memory/dream/dreamModel.ts";
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
import type { Api, Model, Models } from "../../runtime/pi/types.ts";
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
async function deleteTopic(
    store: MemoryStore,
    id: string,
    expectedContent?: string,
): Promise<void> {
    await store.deleteTopic(id, expectedContent === undefined ? undefined : { expectedContent });
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
    registerMethod("memoryList", true, async ({ workspace, server }): Promise<MemoryListResult> => {
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
            ...(dreamJob && !dreamJob.enabled && dreamJob.disabled_reason
                ? { dreamPausedReason: dreamJob.disabled_reason }
                : {}),
        };
    });

    // Manual consolidation always previews, even for a confirmed workspace:
    // the user asked to see what dream would do, not to have it done.
    registerMethod(
        "memoryDreamRun",
        true,
        async ({ workspace, server }): Promise<MemoryDreamRunResult> => {
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
    );

    registerMethod(
        "memoryDreamApply",
        true,
        async ({ workspace, params }): Promise<MemoryDreamApplyResult> => {
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
    );

    registerMethod(
        "memoryDreamDiscard",
        true,
        async ({ workspace }): Promise<MemoryDreamDiscardResult> => {
            discardPendingDream(localStore(workspace));
            return { ok: true };
        },
    );

    registerMethod(
        "memoryDreamUndo",
        true,
        async ({ workspace, params }): Promise<MemoryDreamUndoResult> => {
            try {
                return { conflicts: await undoDreamReport(localStore(workspace), params.reportId) };
            } catch (error) {
                throw asConflict(error);
            }
        },
    );

    registerMethod(
        "memoryRestoreTopic",
        true,
        async ({ workspace, params }): Promise<MemoryRestoreTopicResult> => {
            try {
                await localStore(workspace).restoreTopic(params.id);
            } catch (error) {
                throw asConflict(error);
            }
            return { ok: true };
        },
    );

    registerMethod(
        "memoryWrite",
        true,
        async ({ workspace, params }): Promise<MemoryWriteResult> => {
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
    );

    registerMethod(
        "memoryDeleteTopic",
        true,
        async ({ workspace, params }): Promise<MemoryDeleteTopicResult> => {
            const expected =
                typeof params.expectedContent === "string" ? params.expectedContent : undefined;
            try {
                await deleteTopic(workspace.memoryStore, params.id, expected);
            } catch (error) {
                throw asConflict(error);
            }
            return { ok: true };
        },
    );

    registerMethod(
        "memoryUpsert",
        true,
        async ({ workspace, params }): Promise<MemoryUpsertResult> => {
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
                    // Same content rule as add: an empty replace blanks the
                    // topic, and an oversized one would be injected unbounded.
                    if (
                        typeof params.content !== "string" ||
                        params.content.trim() === "" ||
                        params.content.length > MEMORY_CONTENT_MAX_CHARS
                    ) {
                        throw new RpcHandlerError(
                            ErrorCodes.InvalidParams,
                            `memory.upsert replace: content required, ≤${MEMORY_CONTENT_MAX_CHARS}`,
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
    );
}

/**
 * Model and options for a manual run, resolved as the scheduled job resolves
 * them — the job's `args.model`, else the global default model — so the
 * preview shows the plan the nightly run would make.
 *
 * With no global default configured, the workspace's own default stands in:
 * the scheduled job has nothing to run with then (it skips), but the user who
 * pressed the button can still preview with the model their chats use.
 */
async function resolveManualDreamModel(
    workspace: WorkspaceRuntime,
    server: MethodCtx<unknown>["server"],
): Promise<{
    models: Models;
    model: Model<Api>;
    options: Partial<DreamOptions>;
}> {
    const job = server.jobs ? await server.jobs.get(MEMORY_DREAM_JOB_ID) : null;
    const parsed = job ? parseMemoryDreamArgs(job.args) : undefined;
    const { model: override, ...options }: MemoryDreamArgs = parsed?.ok ? parsed.args : {};
    const resolved = server.providerKeyStore
        ? resolveDreamModel(server.providerKeyStore, override)
        : undefined;
    if (resolved) return { ...resolved, options };
    if (override) {
        throw new RpcHandlerError(
            ErrorCodes.InvalidParams,
            `memory consolidation model not found: ${override}`,
        );
    }
    if (!workspace.defaultModel) {
        throw new RpcHandlerError(
            ErrorCodes.InvalidParams,
            "no model available for memory consolidation",
        );
    }
    return { models: workspace.models, model: workspace.defaultModel, options };
}
