/**
 * useFilePreview — file preview state + cancellation flag.
 *
 * Gate order in select(): binary extension → unsupported extension →
 * oversize (stat before read) → read. Only files passing all gates hit
 * readText, so the webview never pulls in a file it can't render.
 *
 * Cancellation flag pattern: each select() produces a nonce; resolve checks whether it still
 * matches the current nonce — if not, the result is discarded. Rapid A→B→A only shows A's final state.
 */
import { useCallback, useRef, useState } from "react";
import type { FsClient } from "../lib/clients/fsClient";
import { MAX_PREVIEW_BYTES, previewKindFor } from "../lib/fileTypes";
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

            const kind = previewKindFor(lastSegment(relPath));
            if (kind === "binary" || kind === "unsupported") {
                if (myNonce !== nonceRef.current) return;
                setBlock(kind);
                setLoading(false);
                return;
            }

            try {
                const size = await api.sizeOf(relPath);
                if (myNonce !== nonceRef.current) return;
                if (size > MAX_PREVIEW_BYTES) {
                    setBlock("tooLarge");
                    setLoading(false);
                    return;
                }
                const text = await api.readText(relPath);
                if (myNonce !== nonceRef.current) return; // stale
                setContent(text);
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
