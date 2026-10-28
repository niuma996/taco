/**
 * attachments — pure logic for staging files into a message; no React, no Tauri.
 *
 * Replaces the old image-only reader. A file is never read into the webview
 * when it has a path: the sidecar copies it, so a 25 MB PDF never crosses the
 * RPC frame. Bytes are read here only for the paste path, where there is no
 * file to point at.
 */

/// <reference types="vite/client" />
import {
    ATTACHMENT_MAX_BYTES,
    ATTACHMENT_MAX_COUNT,
    ATTACHMENT_STAGE_INLINE_MAX_BYTES,
    type AttachmentStageResult,
    type MessageAttachment,
} from "@taco-ai/protocol";

export { ATTACHMENT_MAX_COUNT };

/** One file waiting in the composer. `previewUrl` is a webview-local blob/asset URL for images. */
export interface StagedAttachment extends AttachmentStageResult {
    previewUrl?: string;
}

/** Why a file was not staged. The composer turns this into a single toast. */
export type AttachRejection = "too_many" | "too_large" | "failed";

export interface AttachOutcome {
    staged: StagedAttachment[];
    rejected: AttachRejection[];
}

/** The two ways a file reaches `attachment.stage`. */
export type StageInput = { path: string } | { name: string; data: string; mimeType?: string };

/**
 * A source as the UI holds it. Pasted bytes stay a Blob until the size check
 * passes, so an oversized paste is refused before it is base64'd.
 */
export type StageSource = { path: string } | { name: string; blob: Blob; mimeType?: string };

export type StageFn = (source: StageInput) => Promise<AttachmentStageResult>;

/**
 * Base64 of a Blob, without the `data:` prefix.
 *
 * `Blob.arrayBuffer` + `btoa` rather than `FileReader` so the same code runs
 * in the webview and under `node:test`, where `FileReader` does not exist.
 */
async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    // Chunked: spreading an 8 MB typed array into one call overflows the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** Files on the clipboard (kind === "file"); some platforms report kind=file but return null. */
export function filesFromClipboard(items: DataTransferItemList): File[] {
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it?.kind !== "file") continue;
        const f = it.getAsFile();
        if (f) {
            files.push(f);
        } else if (import.meta.env.DEV) {
            console.warn("[taco] clipboard item declared kind=file but getAsFile() returned null");
        }
    }
    return files;
}

/** A name for pasted bytes that arrive without one (a screenshot is just "image.png"). */
export function nameForPastedFile(file: File): string {
    if (file.name) return file.name;
    const ext = file.type.split("/")[1]?.split("+")[0];
    return ext ? `pasted.${ext}` : "pasted";
}

/**
 * Stage a batch, respecting the per-message cap across what is already
 * attached. Files are staged one at a time so a failure on one does not
 * cost the others, and the cap is applied in order.
 */
export async function stageSources(
    sources: ReadonlyArray<{ source: StageSource; size?: number; previewUrl?: string }>,
    alreadyAttached: number,
    stage: StageFn,
): Promise<AttachOutcome> {
    const staged: StagedAttachment[] = [];
    const rejected: AttachRejection[] = [];
    for (const item of sources) {
        if (alreadyAttached + staged.length >= ATTACHMENT_MAX_COUNT) {
            rejected.push("too_many");
            continue;
        }
        const source = item.source;
        // Cheap pre-check so an oversized paste is refused before it is base64'd
        // and sent. The sidecar enforces the same limits authoritatively.
        const size = "path" in source ? item.size : source.blob.size;
        const limit = "path" in source ? ATTACHMENT_MAX_BYTES : ATTACHMENT_STAGE_INLINE_MAX_BYTES;
        if (size !== undefined && size > limit) {
            rejected.push("too_large");
            continue;
        }
        try {
            const input: StageInput =
                "path" in source
                    ? source
                    : {
                          name: source.name,
                          mimeType: source.mimeType,
                          data: await blobToBase64(source.blob),
                      };
            const result = await stage(input);
            // The preview is only meaningful for an image. The sidecar decides
            // that from the bytes, so a `.png` that is not one gets an icon.
            const previewUrl = result.kind === "image" ? item.previewUrl : undefined;
            staged.push({ ...result, ...(previewUrl ? { previewUrl } : {}) });
        } catch (err) {
            const fault = err as { data?: { reason?: string } };
            rejected.push(
                fault.data?.reason === "too_large" || fault.data?.reason === "too_many"
                    ? fault.data.reason
                    : "failed",
            );
        }
    }
    return { staged, rejected };
}

/**
 * Chips for the optimistic bubble. The sidecar's echo replaces them with the
 * committed paths; until then `path` is empty, which the chip never shows.
 */
export function toMessageAttachments(staged: readonly StagedAttachment[]): MessageAttachment[] {
    return staged.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
        kind: a.kind,
        path: "",
    }));
}

/** "1.2 MB" / "340 KB" — for the chip subtitle. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
