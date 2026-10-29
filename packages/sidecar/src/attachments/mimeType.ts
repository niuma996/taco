/**
 * MIME detection for attachments.
 *
 * Whether a file travels as an image block is decided from its bytes, not its
 * name or the type the client declared: a renamed `.png` that is really an
 * executable must not be sent to a provider as an image, and a screenshot
 * pasted without an extension still is one. Extensions only label the rest.
 *
 * Only the raster formats model providers accept as image input are sniffed.
 * SVG is deliberately a plain file here: providers reject it, and it can
 * carry script.
 */

import { open } from "node:fs/promises";
import { extname } from "node:path";
import { MODEL_IMAGE_MIME_TYPES, type ModelImageMimeType } from "@taco-ai/protocol";

const MODEL_IMAGE_MIMES: ReadonlySet<string> = new Set(MODEL_IMAGE_MIME_TYPES);

export function isModelImageMime(mimeType: string): mimeType is ModelImageMimeType {
    return MODEL_IMAGE_MIMES.has(mimeType);
}

/**
 * Extension → MIME, the single table for every place that labels a file by
 * its name: attachment classification, channel hints, and the suffix a staged
 * file gets. The raster formats are listed for naming, not for classification
 * — `detectMimeType` only trusts an extension the bytes did not contradict.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".html": "text/html",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const FALLBACK_MIME = "application/octet-stream";

/**
 * The MIME a file name implies.
 *
 * Only a hint: the bytes decide when the two disagree, because a renamed file
 * is still the format its content says it is. The name matters anyway — it is
 * what the model reads, and an extension is how a reader knows what it is
 * holding.
 */
export function mimeTypeFromName(name: string): string {
    return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? FALLBACK_MIME;
}

/** MIME → the extension a name is given, built once so the two cannot drift. */
const EXTENSION_BY_MIME = new Map<string, string>();
for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
    // First extension wins: `.jpg` names an image, `.jpeg` is the alias.
    if (!EXTENSION_BY_MIME.has(mime)) EXTENSION_BY_MIME.set(mime, ext);
}

/** The extension a MIME type is normally given, when a name has none. */
export function extensionForMime(mimeType: string): string | undefined {
    return EXTENSION_BY_MIME.get(mimeType);
}

/** Bytes needed to tell every format below apart. */
const SNIFF_BYTES = 16;

function startsWith(buf: Uint8Array, signature: readonly number[], offset = 0): boolean {
    return signature.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Uint8Array, start: number, end: number): string {
    return String.fromCharCode(...buf.subarray(start, end));
}

/** Magic-byte match for the model-accepted raster formats, else `undefined`. */
export function sniffImageMime(head: Uint8Array): string | undefined {
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
    const gif = ascii(head, 0, 6);
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
    if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
    return undefined;
}

async function readHead(path: string): Promise<Uint8Array> {
    const handle = await open(path, "r");
    try {
        const buf = Buffer.alloc(SNIFF_BYTES);
        const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/**
 * Resolve a file's MIME type: bytes first, then the declared type, then the
 * extension. A declared type is trusted for labelling only; it never turns a
 * file into an image.
 */
export async function detectMimeType(
    path: string,
    declared: string | undefined,
    name: string,
): Promise<string> {
    const sniffed = sniffImageMime(await readHead(path));
    if (sniffed) return sniffed;
    const byExtension = MIME_BY_EXTENSION[extname(name).toLowerCase()];
    // A raster extension the bytes did not confirm is a mislabeled file, so
    // the extension is not trusted for the formats a provider would inline.
    if (byExtension && !isModelImageMime(byExtension)) return byExtension;
    const trimmed = declared?.trim().toLowerCase();
    // A declared image type that the bytes did not confirm is downgraded.
    if (trimmed && !trimmed.startsWith("image/")) return trimmed;
    return FALLBACK_MIME;
}
