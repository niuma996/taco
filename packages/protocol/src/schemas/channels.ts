/**
 * channels.* and imPolicy.* RPC param schemas — the IM surface.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them. The handlers keep the semantic
 * checks (store validation, the chat-override routing rules) a shape cannot
 * express.
 */
import { Type } from "typebox";
import { noParamsSchema } from "./workspace.js";

const channelId = Type.String({ minLength: 1 });

export const channelsListSchema = noParamsSchema;

export const channelsListConversationsSchema = Type.Object({ channelId: Type.Optional(channelId) });

export const channelsCreateSchema = Type.Object({
    name: Type.String({ minLength: 1 }),
    channelId: Type.Optional(Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9-]*$" })),
});

/**
 * Optional credential payload carried by `channels.bind`.
 *
 * Only the WeCom channel consumes it today (static botId + secret from the
 * admin console — no QR flow). Exported so the wire type and the validator
 * read off the same declaration.
 */
export const channelsBindCredsSchema = Type.Object({
    botId: Type.Optional(Type.String()),
    secret: Type.Optional(Type.String()),
});

export const channelsBindSchema = Type.Object({
    channelId,
    force: Type.Optional(Type.Boolean()),
    creds: Type.Optional(channelsBindCredsSchema),
});

export const channelsSubmitVerifyCodeSchema = Type.Object({
    requestId: Type.String({ minLength: 1 }),
    code: Type.String({ minLength: 1 }),
});

export const channelsUnbindSchema = Type.Object({ channelId });

export const channelsRetrySchema = Type.Object({ channelId });

const toolVerdict = Type.Union([Type.Literal("deny"), Type.Literal("allow")]);

/**
 * A policy patch uses `null` to clear a field at the current layer (so the
 * parent layer decides again) and `undefined` to leave it untouched — the
 * schemas keep that distinction, which is why the nullable branches are
 * spelled out rather than folded into an optional.
 */

/** One layer's tool grants. `null` clears the field at this layer. */
const toolsPatch = Type.Object({
    fsTools: Type.Optional(Type.Union([toolVerdict, Type.Null()])),
    shell: Type.Optional(Type.Union([toolVerdict, Type.Null()])),
});

/** One layer's command grants. Rule lists are appended, not replaced. */
const commandsPatch = Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("ask"), Type.Null()])),
    allow: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
    deny: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});

/** Where a channel's tools actually run. */
const executionDir = Type.Object({
    mode: Type.Union([Type.Literal("shared"), Type.Literal("per-chat"), Type.Literal("custom")]),
    path: Type.Optional(Type.String()),
});

/** The patch body shared by the channel-default and chat-override writes. */
const policyPatch = Type.Object({
    tools: Type.Optional(toolsPatch),
    commands: Type.Optional(commandsPatch),
    executionDir: Type.Optional(Type.Union([executionDir, Type.Null()])),
    // Legacy fields, still read from existing policy files.
    binding: Type.Optional(Type.Union([Type.Object({ executionCwd: Type.String() }), Type.Null()])),
    perChatScratch: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});

export const imPolicyGetSchema = Type.Object({
    channelId,
    peerId: Type.Optional(Type.String({ minLength: 1 })),
    chatId: Type.Optional(Type.String({ minLength: 1 })),
});

export const imPolicySetChannelDefaultSchema = Type.Object({
    channelId,
    patch: policyPatch,
});

export const imPolicySetChatOverrideSchema = Type.Object({
    channelId,
    peerId: Type.String({ minLength: 1 }),
    chatId: Type.String({ minLength: 1 }),
    patch: policyPatch,
});

/**
 * Clear by the full route triple (peerId + chatId) or by the raw sha256
 * chatKey when the conversation is no longer routed. Supplying both routes or
 * neither is ambiguous and is rejected by the handler.
 */
export const imPolicyClearChatOverrideSchema = Type.Object({
    channelId,
    peerId: Type.Optional(Type.String({ minLength: 1 })),
    chatId: Type.Optional(Type.String({ minLength: 1 })),
    // The sha256 chats-map key, used when the conversation is no longer routed.
    chatKey: Type.Optional(Type.String({ minLength: 1, pattern: "^[a-f0-9]{64}$" })),
});
