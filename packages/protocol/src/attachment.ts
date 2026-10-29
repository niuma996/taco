/**
 * Attachment RPC types and limits.
 *
 * A file reaches the model in two steps: `attachment.stage` copies it into
 * the sidecar's staging area and returns an id, then `session.prompt` (or
 * steer / followUp / create) names the ids to commit. Clients never send a
 * path with a prompt, so a prompt cannot make the sidecar read an arbitrary
 * file; only `stage` accepts a path.
 */

import type { ParamsOf } from "./rpcContract/types.js";
import type { attachmentStageSchema } from "./schemas/attachment.js";

export type { ModelImageMimeType } from "./attachmentLimits.js";
export {
    ATTACHMENT_MAX_BYTES,
    ATTACHMENT_MAX_COUNT,
    ATTACHMENT_STAGE_INLINE_MAX_BYTES,
    IMAGE_INPUT_MAX_BASE64_LENGTH,
    MODEL_IMAGE_MIME_TYPES,
} from "./attachmentLimits.js";

/** `image` when the bytes are a raster format models accept; `file` otherwise. */
export type AttachmentKind = "image" | "file";

/** `attachment.stage` — either `{ path }` or `{ name, data }`, never both. */
export type AttachmentStageParams = ParamsOf<typeof attachmentStageSchema>;

/**
 * Why an `attachment.*` call refused a file, carried as `data.reason` on the
 * RPC error. The wire `code` stays `invalid_params` for most of these, so a
 * client that wants to say "too large" rather than "failed" reads this.
 */
export type AttachmentRefusalReason =
    | "too_large"
    | "too_many"
    | "not_found"
    | "not_a_file"
    | "bad_id";

/** `attachment.stage` result — what the composer shows and later sends back by `id`. */
export interface AttachmentStageResult {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    kind: AttachmentKind;
}

/**
 * One committed attachment as the sidecar describes it to clients on pushed
 * and replayed user messages. `path` is absolute and lives in the session
 * directory.
 */
export interface MessageAttachment {
    name: string;
    mimeType: string;
    size: number;
    path: string;
    kind: AttachmentKind;
    /**
     * True when the image was also sent to the model as an image block. Set by
     * the sidecar; a client has no use for it beyond not drawing the image twice.
     */
    inlined?: boolean;
}
