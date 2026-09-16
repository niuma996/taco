/**
 * FilePreviewPopup — the floating file-preview window (Radix Dialog).
 *
 * Shared by the file tree and the `read` tool card so both entry points open
 * the same preview surface. It renders nothing when no file is selected.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { UseFilePreviewApi } from "../hooks/useFilePreview";
import { useT } from "../i18n/useI18n";
import { resolveFsPath } from "../lib/clients/fsClient";
import { lastSegment } from "../lib/workspaceStorage";
import { FilesPreviewPane } from "./FilesPreviewPane";

export interface FilePreviewPopupProps {
    preview: UseFilePreviewApi;
    /** Workspace root the preview's path is resolved against. */
    cwd: string;
}

export function FilePreviewPopup({ preview, cwd }: FilePreviewPopupProps) {
    const { t } = useT();
    const path = preview.selectedRelPath;
    if (path === null) return null;

    return (
        <Dialog.Root
            open
            onOpenChange={(next) => {
                if (!next) preview.clear();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="files-preview-backdrop" />
                <Dialog.Content className="files-preview-popup" aria-label={path}>
                    <div className="right-panel-topbar">
                        <Dialog.Title asChild>
                            <h3 className="right-panel-title">{lastSegment(path)}</h3>
                        </Dialog.Title>
                        <button
                            type="button"
                            className="right-panel-close"
                            onClick={() => preview.clear()}
                            aria-label={t("app.dismiss")}
                            title={t("app.dismiss")}
                        >
                            <X size={14} aria-hidden="true" />
                        </button>
                    </div>
                    {/* Keyed by path: resets the markdown rendered/source toggle per file. */}
                    <FilesPreviewPane
                        key={path}
                        selectedRelPath={path}
                        content={preview.content}
                        block={preview.block}
                        error={preview.error}
                        loading={preview.loading}
                        absPath={resolveFsPath(cwd, path)}
                    />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
