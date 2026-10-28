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

/** Image types providers accept as image input. */
const MODEL_IMAGE_MIMES: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

export function isModelImageMime(mimeType: string): boolean {
    return MODEL_IMAGE_MIMES.has(mimeType);
}

const EXTENSION_MIMES: Readonly<Record<string, string>> = {
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
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const FALLBACK_MIME = "application/octet-stream";

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
    const byExtension = EXTENSION_MIMES[extname(name).toLowerCase()];
    if (byExtension) return byExtension;
    const trimmed = declared?.trim().toLowerCase();
    // A declared image type that the bytes did not confirm is downgraded.
    if (trimmed && !trimmed.startsWith("image/")) return trimmed;
    return FALLBACK_MIME;
}
