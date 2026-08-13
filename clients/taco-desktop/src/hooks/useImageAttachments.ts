/**
 * useImageAttachments — 把 File 转 ImageInput、校验、合并到受控 attachments。
 *
 * attachments 本身仍由父组件持有(受控),这个 hook 只封装"加/删/粘贴"的动作逻辑。
 */

import type { ImageInput } from "@taco-ai/protocol";
import { useT } from "../i18n/useI18n";
import { filesFromClipboard, MAX_ATTACHMENTS, readFileAsImage } from "../lib/imageAttachment";
import { useToast } from "./useToast";

export interface UseImageAttachments {
    addFiles: (files: FileList | File[]) => Promise<void>;
    handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
    removeAttachment: (idx: number) => void;
}

export function useImageAttachments(
    attachments: ImageInput[],
    onAttachmentsChange: (next: ImageInput[]) => void,
): UseImageAttachments {
    const { show: showToast } = useToast();
    const { t } = useT();

    /** Converts File[] to ImageInput[] and merges into attachments; validation lives here. */
    async function addFiles(files: FileList | File[]) {
        const arr = Array.from(files);
        const accepted: ImageInput[] = [];
        let rejected = 0;
        for (const f of arr) {
            if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
                rejected++;
                continue;
            }
            const img = await readFileAsImage(f);
            if (img) accepted.push(img);
            else rejected++;
        }
        if (rejected > 0) {
            showToast(
                t("input.attachLimitWarn", { count: rejected, limit: MAX_ATTACHMENTS }),
                "warn",
            );
        }
        if (accepted.length > 0) {
            onAttachmentsChange([...attachments, ...accepted]);
        }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
        const items = e.clipboardData?.items;
        if (!items || items.length === 0) return;
        const files = filesFromClipboard(items);
        if (files.length > 0) {
            // Don't preventDefault — let plain text paste fall through to the textarea.
            // Image paste is additionally added to attachments.
            void addFiles(files);
        }
    }

    function removeAttachment(idx: number) {
        onAttachmentsChange(attachments.filter((_, i) => i !== idx));
    }

    return { addFiles, handlePaste, removeAttachment };
}
