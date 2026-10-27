/**
 * sessionTurn.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/sessionTurn.ts`.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them. The handler keeps the semantic checks
 * (attachment state, queue entries) that a shape cannot express.
 */
import { Type } from "typebox";
import {
    imageInputSchema,
    sessionIdSchema,
    toolCallIdSchema,
    workspaceIdSchema,
} from "./fields.js";

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
const sessionTarget = { workspace: workspaceIdSchema, sessionId: sessionIdSchema };

export const sessionPromptSchema = Type.Object({
    ...sessionTarget,
    text: Type.String(),
    images: Type.Optional(Type.Array(imageInputSchema)),
    // Transient per-turn language hook; also updates the live locale for later turns.
    uiLocale: Type.Optional(locale),
    // Only honored when this prompt attaches a new session. For an attached
    // session, callers must switch models with session.setModel instead.
    model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
});

export const sessionSteerSchema = Type.Object({
    ...sessionTarget,
    text: Type.String(),
    images: Type.Optional(Type.Array(imageInputSchema)),
    uiLocale: Type.Optional(locale),
});

export const sessionFollowUpSchema = sessionSteerSchema;

export const sessionCancelQueuedSchema = Type.Object({
    ...sessionTarget,
    entryId: Type.String(),
});

export const sessionAbortSchema = Type.Object(sessionTarget);

export const subagentAbortSchema = Type.Object({
    workspace: workspaceIdSchema,
    subSessionId: sessionIdSchema,
});

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
    toolCallId: toolCallIdSchema,
    answers: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
    toolName: Type.Optional(Type.String()),
});
