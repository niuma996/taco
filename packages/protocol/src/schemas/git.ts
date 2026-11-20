import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

export const gitInspectSchema = Type.Object(
    { workspace: workspaceIdSchema },
    { additionalProperties: false },
);
export const gitInitSchema = gitInspectSchema;
export const worktreeListSchema = gitInspectSchema;
export const worktreeCreateSchema = Type.Object(
    {
        workspace: workspaceIdSchema,
        name: Type.String({ minLength: 1, maxLength: 80 }),
        base: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("default")])),
    },
    { additionalProperties: false },
);
export const worktreeRemoveSchema = Type.Object(
    { workspace: workspaceIdSchema, path: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export const worktreeCleanupSchema = Type.Object(
    {
        workspace: workspaceIdSchema,
        maxAgeDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
        maxCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
    },
    { additionalProperties: false },
);
