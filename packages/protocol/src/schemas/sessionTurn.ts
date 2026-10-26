/**
 * sessionTurn.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/sessionTurn.ts`.
 *
 * Schemas here are the intended wire contract for each method's `params`:
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects failures
 * with `invalid_params` carrying JSON-pointer paths.
 *
 * These validate RPC envelopes before a request reaches a live session. The
 * handler retains semantic checks such as attachment state and queue entries.
 */

import { Type } from "typebox";

const workspace = Type.String({ minLength: 1 });
const sessionId = Type.String({ minLength: 1 });
const locale = Type.Union([Type.Literal("zh"), Type.Literal("en")]);
const thinkingLevel = Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
]);
const sessionTarget = { workspace, sessionId };

export const sessionPromptSchema = Type.Object({
    ...sessionTarget,
    text: Type.String(),
    images: Type.Optional(Type.Array(Type.Unknown())),
    uiLocale: Type.Optional(locale),
    model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
});

export const sessionSteerSchema = Type.Object({
    ...sessionTarget,
    text: Type.String(),
    images: Type.Optional(Type.Array(Type.Unknown())),
    uiLocale: Type.Optional(locale),
});

export const sessionFollowUpSchema = sessionSteerSchema;

export const sessionCancelQueuedSchema = Type.Object({ ...sessionTarget, entryId: Type.String() });

export const sessionAbortSchema = Type.Object(sessionTarget);

export const subagentAbortSchema = Type.Object({ workspace, subSessionId: sessionId });

export const sessionSetModelSchema = Type.Object({
    ...sessionTarget,
    provider: Type.String(),
    modelId: Type.String(),
});

export const sessionSetThinkingLevelSchema = Type.Object({
    ...sessionTarget,
    level: thinkingLevel,
});

export const sessionCompactSchema = Type.Object({
    ...sessionTarget,
    customInstructions: Type.Optional(Type.String()),
});

export const sessionContextInfoSchema = Type.Object(sessionTarget);

export const sessionSubmitAnswersSchema = Type.Object({
    ...sessionTarget,
    toolCallId: Type.String({ minLength: 1 }),
    answers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
    toolName: Type.Optional(Type.String()),
});
