/**
 * sessionLifecycle.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/sessionLifecycle.ts`.
 *
 * Schemas here are the intended wire contract for each method's `params`:
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects failures
 * with `invalid_params` carrying JSON-pointer paths.
 *
 * These schemas deliberately validate only the stable envelope. The handler
 * remains responsible for semantic checks (session existence, cursor bounds,
 * and IM routing), but malformed requests never reach it.
 */

import { Type } from "typebox";

const workspace = Type.String({ minLength: 1 });
const sessionId = Type.String({ minLength: 1 });
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
    workspace,
    limit: Type.Optional(Type.Number()),
    cursor: Type.Optional(Type.Object({ updatedAt: Type.String(), id: Type.String() })),
    full: Type.Optional(Type.Boolean()),
});

export const sessionCreateSchema = Type.Object({
    workspace,
    sessionId: Type.Optional(sessionId),
    initialPrompt: Type.Optional(Type.String()),
    initialImages: Type.Optional(Type.Array(Type.Unknown())),
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
    workspace,
    sessionId,
    thinkingLevel: Type.Optional(thinkingLevel),
});

export const sessionDetachSchema = Type.Object({ workspace, sessionId });

export const sessionDeleteSchema = Type.Object({ workspace, sessionId });

export const sessionRenameSchema = Type.Object({ workspace, sessionId, name: Type.String() });
