/**
 * session.* RPC param schemas — the lifecycle, read and turn envelopes.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them. The handlers keep the semantic
 * checks (session existence, cursor bounds, IM routing) a shape cannot
 * express.
 */
import { Type } from "typebox";
import type { InitializeParams } from "../frames.js";
import {
    imageInputSchema,
    sessionIdSchema,
    toolCallIdSchema,
    workspaceIdSchema,
} from "./fields.js";

const workspace = workspaceIdSchema;

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
    // Omitted or <= 0 means SESSION_LIST_DEFAULT_LIMIT; the server clamps to SESSION_LIST_MAX_LIMIT.
    limit: Type.Optional(Type.Number()),
    cursor: Type.Optional(Type.Object({ updatedAt: Type.String(), id: sessionIdSchema })),
    full: Type.Optional(Type.Boolean()),
});

export const sessionCreateSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: Type.Optional(sessionIdSchema),
    initialPrompt: Type.Optional(Type.String()),
    // May accompany an empty initialPrompt: image-only first turns are valid.
    initialImages: Type.Optional(Type.Array(imageInputSchema)),
    thinkingLevel: Type.Optional(thinkingLevel),
    // Sets the first reply-language hook for this new session; never persisted.
    uiLocale: Type.Optional(locale),
    // Authoritative IM route, written to jsonl metadata when the session is created.
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

export const sessionHistorySchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionEventsGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
    afterSeq: Type.Integer({ minimum: 0 }),
});

export const sessionSnapshotGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionTasksGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionTaskHistoryGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
    listId: Type.String({ minLength: 1 }),
});

export const sessionPlanStateGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

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

/**
 * The schema stays `Type.Unknown()` — the gate is deliberately open — but the
 * static type is pinned to `InitializeParams` so the contract table still
 * declares what a well-formed `initialize` carries. `Type.Unsafe` changes
 * only the static side: at runtime the schema still accepts anything, which
 * is the point of keeping the gate open.
 */
/**
 * The `initialize` gate is deliberately permissive: `Type.Unknown()` accepts
 * ANY value, so this schema performs no validation. The real check lives in
 * the handler, which rejects a missing or non-numeric
 * `protocolVersion.{major,minor}` with `invalid_params` and an incompatible
 * version with `incompatible_protocol`. A client that sends a partial
 * capability payload must still reach the handler's version-negotiation path
 * instead of being rejected at the envelope.
 */
export const initializeSchema = Type.Unsafe<InitializeParams>(Type.Unknown());

export const sessionListModelsSchema = Type.Object({
    workspace,
    provider: Type.Optional(Type.String({ minLength: 1 })),
});
