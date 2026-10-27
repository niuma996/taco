/**
 * memory.* and checkpoints.* RPC param schemas.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them. The handlers keep the semantic
 * checks (topic id whitelist, content length, stale-hash conflicts) a
 * shape cannot express.
 */
import { Type } from "typebox";
import { sessionIdSchema, workspaceIdSchema } from "./fields.js";

const workspace = workspaceIdSchema;

export const memoryListSchema = Type.Object({ workspace });

export const memoryWriteSchema = Type.Object({
    workspace,
    content: Type.String(),
    baseHash: Type.String(),
});

export const memoryDeleteTopicSchema = Type.Object({
    workspace,
    id: Type.String({ minLength: 1, maxLength: 128 }),
    expectedContent: Type.Optional(Type.String()),
});

export const memoryUpsertSchema = Type.Object({
    workspace,
    action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" }),
    // Required on add. The handler applies the same length limit as the schema.
    name: Type.Optional(Type.String({ maxLength: 60 })),
    // Optional on add; one-line relevance hint. Defaults to name in the handler.
    description: Type.Optional(Type.String({ maxLength: 120 })),
    // Required on add/replace; the handler enforces MEMORY_CONTENT_MAX_CHARS.
    content: Type.Optional(Type.String()),
    // Required on add.
    type: Type.Optional(
        Type.Union([
            Type.Literal("user"),
            Type.Literal("feedback"),
            Type.Literal("project"),
            Type.Literal("reference"),
        ]),
    ),
});

export const memoryDreamRunSchema = Type.Object({ workspace });

export const memoryDreamApplySchema = Type.Object({
    workspace,
    previewId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
});

export const memoryDreamDiscardSchema = Type.Object({ workspace });

export const memoryDreamUndoSchema = Type.Object({
    workspace,
    reportId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
});

export const memoryRestoreTopicSchema = Type.Object({
    workspace,
    id: Type.String({ minLength: 1, maxLength: 128 }),
});

export const checkpointsListSchema = Type.Object({
    workspace,
    sessionId: Type.Optional(sessionIdSchema),
});

export const checkpointsRestoreSchema = Type.Object({
    workspace,
    checkpointId: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(sessionIdSchema),
});
