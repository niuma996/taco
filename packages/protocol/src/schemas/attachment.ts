/**
 * attachment.* RPC param schemas.
 *
 * `attachment.stage` takes exactly one source: a local `path` the sidecar
 * copies itself, or an inline base64 `data` body for the paste path where no
 * file exists. Both variants are closed (`additionalProperties: false`), so a
 * call carrying a path and a body matches neither and is rejected by the
 * schema instead of the handler guessing which one the caller meant.
 */
import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

const workspace = workspaceIdSchema;

const stageFromPathSchema = Type.Object(
    {
        workspace,
        path: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

const stageFromDataSchema = Type.Object(
    {
        workspace,
        name: Type.String({ minLength: 1, maxLength: 255 }),
        mimeType: Type.Optional(Type.String({ maxLength: 255 })),
        // Size is capped by the handler, which can name the limit in its error;
        // a schema maxLength would only report a bare validation failure.
        data: Type.String(),
    },
    { additionalProperties: false },
);

export const attachmentStageSchema = Type.Union([stageFromPathSchema, stageFromDataSchema]);

/** A staged attachment id, as returned by `attachment.stage`. */
export const attachmentIdSchema = Type.String({ minLength: 1, maxLength: 64 });
