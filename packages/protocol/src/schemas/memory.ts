/**
 * memory.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/memory.ts`.
 *
 * The schema validates the envelope before dispatch; the handler still owns
 * the semantic checks (topic id whitelist, content length, stale-hash
 * conflicts).
 */

import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

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
    name: Type.Optional(Type.String({ maxLength: 60 })),
    description: Type.Optional(Type.String({ maxLength: 120 })),
    content: Type.Optional(Type.String()),
    type: Type.Optional(
        Type.Union([
            Type.Literal("user"),
            Type.Literal("feedback"),
            Type.Literal("project"),
            Type.Literal("reference"),
        ]),
    ),
});

export const memoryDreamRunSchema = Type.Object({ workspace: workspaceIdSchema });

export const memoryDreamApplySchema = Type.Object({
    workspace: workspaceIdSchema,
    previewId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
});

export const memoryDreamDiscardSchema = Type.Object({ workspace: workspaceIdSchema });

export const memoryDreamUndoSchema = Type.Object({
    workspace: workspaceIdSchema,
    reportId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
});

export const memoryRestoreTopicSchema = Type.Object({
    workspace: workspaceIdSchema,
    id: Type.String({ minLength: 1, maxLength: 128 }),
});
