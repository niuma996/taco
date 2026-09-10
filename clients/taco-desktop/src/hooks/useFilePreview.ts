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
    select(relPath: string): Promise<void>;
    clear(): void;
}

export function useFilePreview(api: FsClient): UseFilePreviewApi {
    const [selectedRelPath, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [content, setContent] = useState<string | null>(null);
    const [block, setBlock] = useState<PreviewBlock | null>(null);
    const [error, setError] = useState<string | null>(null);
    const nonceRef = useRef(0);

    const clear = useCallback(() => {
        nonceRef.current += 1; // cancel in-flight
        setSelected(null);
        setLoading(false);
        setContent(null);
        setBlock(null);
        setError(null);
    }, []);

    const select = useCallback(
        async (relPath: string) => {
            const myNonce = ++nonceRef.current;
            setSelected(relPath);
            setLoading(true);
            setError(null);
            setContent(null);
            setBlock(null);

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
                setError((e as Error).message);
                setLoading(false);
            }
        },
        [api],
    );

    return {
        selectedRelPath,
        loading,
        content,
        block,
        error,
        select,
        clear,
    };
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
