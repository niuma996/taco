/**
 * sessionLifecycle.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/sessionLifecycle.ts`.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them. The handler keeps the semantic
 * checks (session existence, cursor bounds, IM routing) a shape cannot
 * express.
 */
import { Type } from "typebox";
import { imageInputSchema, sessionIdSchema, workspaceIdSchema } from "./fields.js";

const thinkingLevel = Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
]);
const locale = Type.Union([Type.Literal("zh"), Type.Literal("en")]);

export const sessionListSchema = Type.Object({
    workspace: workspaceIdSchema,
    limit: Type.Optional(Type.Number()),
    cursor: Type.Optional(Type.Object({ updatedAt: Type.String(), id: sessionIdSchema })),
    full: Type.Optional(Type.Boolean()),
});

export const sessionCreateSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: Type.Optional(sessionIdSchema),
    initialPrompt: Type.Optional(Type.String()),
    initialImages: Type.Optional(Type.Array(imageInputSchema)),
    thinkingLevel: Type.Optional(thinkingLevel),
    uiLocale: Type.Optional(locale),
    imRouting: Type.Optional(
        Type.Object({
            channelId: Type.String({ minLength: 1 }),
            peerId: Type.String({ minLength: 1 }),
            chatId: Type.String({ minLength: 1 }),
        }),
    ),
});

export const sessionAttachSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
    thinkingLevel: Type.Optional(thinkingLevel),
});

export const sessionDetachSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionDeleteSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionRenameSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
    name: Type.String(),
});
