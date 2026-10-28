/**
 * useAttachments — stage files for the next prompt: picker, drag-drop, paste.
 *
 * Replaces useImageAttachments. `attachments` stays owned by the parent
 * (controlled); this hook only owns the actions.
 *
 * Files with a real path (picker, drag-drop) are staged by path, so the
 * sidecar copies them and a large PDF never crosses the RPC frame. Pasted
 * files have no path and are staged by bytes.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useI18n";
import {
    ATTACHMENT_MAX_COUNT,
    type AttachRejection,
    filesFromClipboard,
    nameForPastedFile,
    type StagedAttachment,
    type StageFn,
    stageSources,
} from "../../lib/attachments";
import { useToast } from "./useToast";

export interface UseAttachments {
    /** Open the native file picker (any file type). */
    pick: () => Promise<void>;
    handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
    removeAttachment: (idx: number) => void;
    /** True while a drag is hovering the window, for the drop affordance. */
    dragging: boolean;
}

/** One toast for a batch, naming the most useful reason. */
function rejectionKey(rejected: readonly AttachRejection[]): string {
    if (rejected.includes("too_many")) return "input.attachTooMany";
    if (rejected.includes("too_large")) return "input.attachTooLarge";
    return "input.attachFailed";
}

export function useAttachments(
    attachments: StagedAttachment[],
    onAttachmentsChange: (next: StagedAttachment[]) => void,
    stage: StageFn,
    /** Disabled while the composer is locked (compaction, session loading). */
    enabled: boolean,
): UseAttachments {
    const { show: showToast } = useToast();
    const { t } = useT();
    const [dragging, setDragging] = useState(false);

    // The drag-drop listener is registered once; it reads the latest values
    // through a ref instead of re-subscribing on every keystroke.
    // Object URLs made for pasted previews. Revoked on removal; whatever is left
    // (sent, or rejected by the sidecar) is released when the pane unmounts.
    const objectUrls = useRef(new Set<string>());
    useEffect(() => {
        const urls = objectUrls.current;
        return () => {
            for (const url of urls) URL.revokeObjectURL(url);
            urls.clear();
        };
    }, []);

    const latest = useRef({ attachments, onAttachmentsChange, stage, enabled, addPaths });
    latest.current = { attachments, onAttachmentsChange, stage, enabled, addPaths };

    async function addSources(sources: Parameters<typeof stageSources>[0]): Promise<void> {
        const cur = latest.current;
        const { staged, rejected } = await stageSources(sources, cur.attachments.length, cur.stage);
        if (rejected.length > 0) {
            showToast(
                t(rejectionKey(rejected), { count: rejected.length, limit: ATTACHMENT_MAX_COUNT }),
                "warn",
            );
        }
        // Read the list again: staging is async and the user may have removed
        // or added something meanwhile.
        if (staged.length > 0) {
            latest.current.onAttachmentsChange([...latest.current.attachments, ...staged]);
        }
    }

    async function addPaths(paths: readonly string[]): Promise<void> {
        // The original file previews through the asset protocol; the staged copy
        // is not addressable from the webview.
        await addSources(
            paths.map((path) => ({ source: { path }, previewUrl: convertFileSrc(path) })),
        );
    }

    async function pick(): Promise<void> {
        const chosen = await openDialog({ multiple: true, directory: false });
        if (!chosen) return;
        await addPaths(Array.isArray(chosen) ? chosen : [chosen]);
    }

    function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
        const items = e.clipboardData?.items;
        if (!items || items.length === 0) return;
        const files = filesFromClipboard(items);
        if (files.length === 0) return;
        // A copied file puts its name or URL on the clipboard as text too;
        // without this, that text lands in the textarea next to the chip.
        // Plain text pastes carry no file items and are untouched.
        e.preventDefault();
        if (!latest.current.enabled) return;
        void (async () => {
            const sources = files.map((file) => {
                const previewUrl = URL.createObjectURL(file);
                objectUrls.current.add(previewUrl);
                return {
                    previewUrl,
                    size: file.size,
                    source: {
                        name: nameForPastedFile(file),
                        mimeType: file.type || undefined,
                        // Kept as a Blob: stageSources checks the size before
                        // it reads the bytes, so an oversized paste never
                        // becomes a base64 string in the webview.
                        blob: file,
                    },
                };
            });
            await addSources(sources);
        })();
    }

    function removeAttachment(idx: number) {
        const removed = attachments[idx];
        if (removed?.previewUrl && objectUrls.current.delete(removed.previewUrl)) {
            URL.revokeObjectURL(removed.previewUrl);
        }
        onAttachmentsChange(attachments.filter((_, i) => i !== idx));
    }

    // Native drag-drop. Tauri swallows the HTML5 drop event for files, so this
    // is the only way to get real paths from a drop.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        void getCurrentWebview()
            .onDragDropEvent((event) => {
                const p = event.payload;
                if (p.type === "enter" || p.type === "over") {
                    if (latest.current.enabled) setDragging(true);
                } else if (p.type === "leave") {
                    setDragging(false);
                } else if (p.type === "drop") {
                    setDragging(false);
                    if (latest.current.enabled && p.paths.length > 0)
                        void latest.current.addPaths(p.paths);
                }
            })
            .then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    return { pick, handlePaste, removeAttachment, dragging };
}
