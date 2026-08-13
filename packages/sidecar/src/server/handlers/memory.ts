/**
 * memory.* handler — lets the desktop MemoryPane read and write the
 * memory subsystem.
 *
 * Key constraint: reuse MethodCtx.workspace.memoryStore; never `new`
 * a fresh instance. Writes must share the same writeChain as the
 * extractor — that shared chain is the whole reason this design holds.
 * All three methods are ensureWorkspace: true (workspace-scoped);
 * MethodCtx auto-injects the workspace.
 */

import type {
    MemoryDeleteTopicParams,
    MemoryDeleteTopicResult,
    MemoryListParams,
    MemoryListResult,
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
    memoryListSchema,
    memoryUpsertSchema,
    memoryWriteSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";

import { hashOf } from "../../memory/local/store.ts";
import { MemoryConflictError } from "../../memory/types.ts";
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

export function registerMemoryHandlers(): void {
    registerMethod(
        RPC.memoryList,
        true,
        async ({ workspace }: MethodCtx<MemoryListParams>): Promise<MemoryListResult> => {
            const store = workspace.memoryStore;
            const content = store.readMemory();
            return {
                memoryContent: content,
                memoryHash: hashOf(content),
                topics: store.listTopics().map(toWireTopic),
                enabled: store.enabled,
            };
        },
        { schema: memoryListSchema },
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
            await workspace.memoryStore.deleteTopic(params.id);
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
            const validatedId = params.id.toLowerCase().replace(/[^a-z0-9-]/g, "");
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
                    await store.deleteTopic(validatedId);
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
