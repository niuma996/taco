/**
 * useFilePreview — file preview state + cancellation flag.
 *
 * Gate order in select(): binary extension → unsupported extension →
 * oversize (stat before read) → read. Only files passing all gates hit
 * readText / readBinary, so the webview never pulls in a file it can't render.
 *
 * Images read as bytes and become a `data:` URL in `content`; everything else
 * reads as text.
 *
 * Cancellation flag pattern: each select() produces a nonce; resolve checks whether it still
 * matches the current nonce — if not, the result is discarded. Rapid A→B→A only shows A's final state.
 */
import { useCallback, useRef, useState } from "react";
import type { FsClient } from "../lib/clients/fsClient";
import {
    imageMimeFor,
    MAX_IMAGE_PREVIEW_BYTES,
    MAX_PREVIEW_BYTES,
    previewKindFor,
} from "../lib/fileTypes";
import { lastSegment } from "../lib/workspaceStorage";

/** Why a file can't be previewed. null = content is readable. */
export type PreviewBlock = "binary" | "unsupported" | "tooLarge";

export interface UseFilePreviewApi {
    selectedRelPath: string | null;
    loading: boolean;
    content: string | null;
    block: PreviewBlock | null;
    error: string | null;
    /** True when the read failed because the path is outside the FS scope. */
    forbidden: boolean;
    select(relPath: string): Promise<void>;
    /** Re-read the current file. Call after the user grants access. */
    retry(): Promise<void>;
    clear(): void;
}

export function useFilePreview(api: FsClient): UseFilePreviewApi {
    const [selectedRelPath, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [content, setContent] = useState<string | null>(null);
    const [block, setBlock] = useState<PreviewBlock | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [forbidden, setForbidden] = useState(false);
    const nonceRef = useRef(0);

    const clear = useCallback(() => {
        nonceRef.current += 1; // cancel in-flight
        setSelected(null);
        setLoading(false);
        setContent(null);
        setBlock(null);
        setError(null);
        setForbidden(false);
    }, []);

    const load = useCallback(
        async (relPath: string) => {
            const myNonce = ++nonceRef.current;
            setSelected(relPath);
            setLoading(true);
            setError(null);
            setContent(null);
            setBlock(null);
            setForbidden(false);

            const name = lastSegment(relPath);
            const imageMime = imageMimeFor(name);
            const kind = previewKindFor(name);
            if (kind === "binary" || kind === "unsupported") {
                if (myNonce !== nonceRef.current) return;
                setBlock(kind);
                setLoading(false);
                return;
            }

            try {
                const size = await api.sizeOf(relPath);
                if (myNonce !== nonceRef.current) return;
                if (size > (imageMime !== null ? MAX_IMAGE_PREVIEW_BYTES : MAX_PREVIEW_BYTES)) {
                    setBlock("tooLarge");
                    setLoading(false);
                    return;
                }
                if (imageMime !== null) {
                    const bytes = await api.readBinary(relPath);
                    if (myNonce !== nonceRef.current) return; // stale
                    setContent(bytesToDataUrl(bytes, imageMime));
                } else {
                    const text = await api.readText(relPath);
                    if (myNonce !== nonceRef.current) return; // stale
                    setContent(text);
                }
                setLoading(false);
            } catch (e) {
                if (myNonce !== nonceRef.current) return;
                setError(errorText(e));
                setForbidden(isForbiddenPath(e));
                setLoading(false);
            }
        },
        [api],
    );

    const retry = useCallback(async () => {
        if (selectedRelPath === null) return;
        await load(selectedRelPath);
    }, [load, selectedRelPath]);

    return {
        selectedRelPath,
        loading,
        content,
        block,
        error,
        forbidden,
        select: load,
        retry,
        clear,
    };
}

/**
 * Whether the rejection is tauri-plugin-fs refusing a path outside the
 * allowed scope (`Error::PathForbidden`), as opposed to a real IO failure.
 * Matched on the message because the plugin serializes its error to a string
 * across the IPC boundary, discarding the variant.
 */
function isForbiddenPath(e: unknown): boolean {
    return errorText(e).toLowerCase().includes("forbidden path");
}

/**
 * Tauri's `invoke` rejects with a plain string, not an Error — reading
 * `.message` off it yields undefined, which the pane renders as a blank body
 * instead of an error. Never return "" for a non-empty rejection.
 */
function errorText(e: unknown): string {
    if (e instanceof Error && e.message) return e.message;
    const s = String(e);
    return s === "" || s === "[object Object]" ? "unknown error" : s;
}

/** Bytes → base64 `data:` URL. Chunked so a large image doesn't overflow the argument limit of `String.fromCharCode(...)`. */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${mime};base64,${btoa(binary)}`;
}
