/// <reference types="vite/client" />
/**
 * imageAttachment — pure validation / conversion logic for image attachments; no UI dependency.
 * Extracted from ChatPane to allow future extension to voice / file attachments with shared validation rules.
 */

import type { ImageInput } from "@taco-ai/protocol";

/** Per-image byte limit; base64 adds ~33%, so 5 MB → ~6.7 MB base64, safely under the NDJSON frame limit (~10 MB). Only used internally; not exported. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Max 4 images per message — reject beyond to prevent misuse and payload bloat. */
export const MAX_ATTACHMENTS = 4;

/** FileReader.readAsDataURL → strip `data:<mime>;base64,` prefix, keep only base64. Returns null on failure / non-image MIME / oversized; caller decides fallback. */
export async function readFileAsImage(file: File): Promise<ImageInput | null> {
    if (!file.type.startsWith("image/")) return null;
    if (file.size > MAX_IMAGE_BYTES) return null;
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onerror = () => resolve(null);
        reader.onload = () => {
            const result = reader.result;
            if (typeof result !== "string") return resolve(null);
            const commaIdx = result.indexOf(",");
            if (commaIdx < 0) return resolve(null);
            const data = result.slice(commaIdx + 1);
            resolve({ type: "image", data, mimeType: file.type });
        };
        reader.readAsDataURL(file);
    });
}

/** Extracts Files from clipboard items (kind === "file"). Some platforms (Linux/Wayland) may declare kind=file but return null from getAsFile(); silently skips those and console.warn once in dev mode for debugging. */
export function filesFromClipboard(items: DataTransferItemList): File[] {
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it?.kind === "file") {
            const f = it.getAsFile();
            if (f) {
                files.push(f);
            } else if (import.meta.env.DEV) {
                console.warn(
                    "[taco] clipboard item declared kind=file but getAsFile() returned null",
                    it.type,
                );
            }
        }
    }
    return files;
}
