/**
 * Shared field schemas — the building blocks every request schema is made of.
 *
 * The id fields carry a brand: at runtime they are plain non-empty strings,
 * while the static type keeps `WorkspaceId` / `SessionId` / `ToolCallId`. That
 * is what stops a session id being passed where a workspace id is expected —
 * `Type.Unsafe` attaches the brand to a schema whose runtime behaviour is an
 * ordinary string.
 */
import { Type } from "typebox";
import {
    ATTACHMENT_MAX_COUNT,
    IMAGE_INPUT_MAX_BASE64_LENGTH,
    MODEL_IMAGE_MIME_TYPES,
} from "../attachmentLimits.js";
import type { SessionId, ToolCallId, WorkspaceId } from "../frames.js";

export const workspaceIdSchema = Type.Unsafe<WorkspaceId>(Type.String({ minLength: 1 }));
export const sessionIdSchema = Type.Unsafe<SessionId>(Type.String({ minLength: 1 }));
export const toolCallIdSchema = Type.Unsafe<ToolCallId>(Type.String({ minLength: 1 }));

/**
 * An image attached to a prompt. Bounded here because the bytes go straight
 * to the model: an unsupported type fails the whole request upstream, and an
 * unbounded body would let one frame carry anything.
 */
export const imageInputSchema = Type.Object({
    type: Type.Literal("image"),
    data: Type.String({ maxLength: IMAGE_INPUT_MAX_BASE64_LENGTH }),
    // Static type stays `string` (matching `ImageInput` and pi's ImageContent);
    // the whitelist is a runtime check at the wire.
    mimeType: Type.Unsafe<string>(Type.Union(MODEL_IMAGE_MIME_TYPES.map((m) => Type.Literal(m)))),
});

/** The `images` list on a prompt. */
export const imageInputsSchema = Type.Array(imageInputSchema, { maxItems: ATTACHMENT_MAX_COUNT });
