/**
 * channels.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/channels.ts`.
 *
 * Schemas here are the intended wire contract for each method's `params`:
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects failures
 * with `invalid_params` carrying JSON-pointer paths.
 *
 * These schemas reject malformed channel-management envelopes before they can
 * trigger credential or connection operations.
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
