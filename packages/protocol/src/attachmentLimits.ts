/**
 * Attachment and image-input caps.
 *
 * Schemas import these. They live here, not in `attachment.ts`, because that
 * module imports the stage schema — a schema importing it back would cycle.
 */

/** Largest file `attachment.stage` accepts, from a path or an inline body. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Largest inline (`data`) body. Lower than the file cap because the body
 * travels as base64 inside one NDJSON frame, ~33% larger than the file.
 */
export const ATTACHMENT_STAGE_INLINE_MAX_BYTES = 8 * 1024 * 1024;

/** Most attachments one message may carry. */
export const ATTACHMENT_MAX_COUNT = 8;

/**
 * Image types providers accept as an image block. SVG is not one: providers
 * reject it, and it can carry script.
 */
export const MODEL_IMAGE_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
] as const;

export type ModelImageMimeType = (typeof MODEL_IMAGE_MIME_TYPES)[number];

/**
 * Longest base64 `data` on an inline image block: the inline staging cap,
 * base64-encoded. A raw image on `images` travels in one NDJSON frame exactly
 * like a pasted attachment, so it gets the same bound.
 */
export const IMAGE_INPUT_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_STAGE_INLINE_MAX_BYTES / 3) * 4;
