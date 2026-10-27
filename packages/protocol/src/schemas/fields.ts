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
import type { ImageInput, SessionId, ToolCallId, WorkspaceId } from "../frames.js";

export const workspaceIdSchema = Type.Unsafe<WorkspaceId>(Type.String({ minLength: 1 }));
export const sessionIdSchema = Type.Unsafe<SessionId>(Type.String({ minLength: 1 }));
export const toolCallIdSchema = Type.Unsafe<ToolCallId>(Type.String({ minLength: 1 }));

/** An image attached to a prompt. */
export const imageInputSchema = Type.Unsafe<ImageInput>(
    Type.Object({
        type: Type.Literal("image"),
        data: Type.String(),
        mimeType: Type.String(),
    }),
);
