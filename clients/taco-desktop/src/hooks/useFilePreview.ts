/**
 * useFilePreview — file preview state + cancellation flag.
 *
 * Cancellation flag pattern: each select() produces a nonce; resolve checks whether it still
 * matches the current nonce — if not, the result is discarded. Rapid A→B→A only shows A's final state.
 */
import { useCallback, useRef, useState } from "react";
import type { FsClient } from "../lib/clients/fsClient";
import { isBinary, TEXT_TRUNCATE_BYTES } from "../lib/fileTypes";
import { lastSegment } from "../lib/workspaceStorage";

export interface UseFilePreviewApi {
    selectedRelPath: string | null;
    loading: boolean;
    content: string | null;
    binary: boolean;
    truncated: boolean;
    error: string | null;
    select(relPath: string): Promise<void>;
    clear(): void;
}

export function useFilePreview(api: FsClient): UseFilePreviewApi {
    const [selectedRelPath, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [content, setContent] = useState<string | null>(null);
    const [binary, setBinary] = useState(false);
    const [truncated, setTruncated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const nonceRef = useRef(0);

    const clear = useCallback(() => {
        nonceRef.current += 1; // cancel in-flight
        setSelected(null);
        setLoading(false);
        setContent(null);
        setBinary(false);
        setTruncated(false);
        setError(null);
    }, []);

    const select = useCallback(
        async (relPath: string) => {
            const myNonce = ++nonceRef.current;
            setSelected(relPath);
            setLoading(true);
            setError(null);
            setContent(null);
            setBinary(false);
            setTruncated(false);

            const basename = lastSegment(relPath);
            if (isBinary(basename)) {
                if (myNonce !== nonceRef.current) return;
                setBinary(true);
                setLoading(false);
                return;
            }

            try {
                const text = await api.readText(relPath);
                if (myNonce !== nonceRef.current) return; // stale
                if (text.length > TEXT_TRUNCATE_BYTES) {
                    setContent(text.slice(0, TEXT_TRUNCATE_BYTES));
                    setTruncated(true);
                } else {
                    setContent(text);
                    setTruncated(false);
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
        binary,
        truncated,
        error,
        select,
        clear,
    };
}
