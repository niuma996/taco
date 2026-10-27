/**
 * memory.* and checkpoints.* RPC param schemas.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them. The handlers keep the semantic
 * checks (topic id whitelist, content length, stale-hash conflicts) a
 * shape cannot express.
 *
 * The topic field schemas are exported individually because the sidecar's
 * model-facing memory tool reuses them verbatim. Guidance for the model
 * therefore lives here, as the schema's `description` — a second copy in the
 * tool layer is a copy that drifts.
 */
import { Type } from "typebox";
import { sessionIdSchema, workspaceIdSchema } from "./fields.js";

const workspace = workspaceIdSchema;

export const memoryListSchema = Type.Object({ workspace });

/**
 * The action a `memory.upsert` performs — add a topic, replace an existing
 * one, or remove it.
 */
export const memoryTopicActionSchema = Type.Union([
    Type.Literal("add"),
    Type.Literal("replace"),
    Type.Literal("remove"),
]);

/**
 * Topic id — kebab-case. The handler whitelists the same shape, so a bad id
 * is rejected at the schema gate instead of being silently sanitized.
 */
export const memoryTopicIdSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z0-9-]+$",
});

/** Short human-readable title for a topic. */
export const memoryTopicNameSchema = Type.String({
    maxLength: 60,
    description: "Short human-readable title for this memory. Not a sentence.",
});

/** One-line relevance hint — the handler defaults it to the topic name. */
export const memoryTopicDescriptionSchema = Type.String({
    maxLength: 120,
    description:
        "One line stating what this memory is about, used to judge relevance in later sessions. Defaults to `name`.",
});

/** What kind of fact the topic holds. */
export const memoryTopicTypeSchema = Type.Union([
    Type.Literal("user"),
    Type.Literal("feedback"),
    Type.Literal("project"),
    Type.Literal("reference"),
]);

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
    action: memoryTopicActionSchema,
    id: memoryTopicIdSchema,
    // Required on add. The handler applies the same length limit as the schema.
    name: Type.Optional(memoryTopicNameSchema),
    // Optional on add; one-line relevance hint. Defaults to name in the handler.
    description: Type.Optional(memoryTopicDescriptionSchema),
    // Required on add/replace; the handler enforces MEMORY_CONTENT_MAX_CHARS.
    content: Type.Optional(Type.String()),
    // Required on add.
    type: Type.Optional(memoryTopicTypeSchema),
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
