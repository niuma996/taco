/**
 * FilePreviewPopup — the floating file-preview window (Radix Dialog).
 *
 * Shared by the file tree and the `read` tool card so both entry points open
 * the same preview surface. It renders nothing when no file is selected.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { UseFilePreviewApi } from "../hooks/useFilePreview";
import { useT } from "../i18n/useI18n";
import { resolveFsPath } from "../lib/clients/fsClient";
import { lastSegment } from "../lib/workspaceStorage";
import { FilesPreviewPane } from "./FilesPreviewPane";
import { IconButton } from "./ui/IconButton";

export interface FilePreviewPopupProps {
    preview: UseFilePreviewApi;
    /** Workspace root the preview's path is resolved against. */
    cwd: string;
}

export function FilePreviewPopup({ preview, cwd }: FilePreviewPopupProps) {
    const { t } = useT();
    const path = preview.selectedRelPath;
    if (path === null) return null;
    const absPath = resolveFsPath(cwd, path);

    // The grant is file-granular and lasts until the app restarts; the user's
    // click on the button in ForbiddenPreview is the authorization.
    const grantAccess = () => {
        void tauriInvoke("allow_fs_file", { path: absPath })
            .then(() => preview.retry())
            .catch((e: unknown) => {
                console.error("[taco] allow_fs_file failed", e);
            });
    };

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
                        <IconButton
                            onClick={() => preview.clear()}
                            aria-label={t("app.dismiss")}
                            title={t("app.dismiss")}
                        >
                            <X size={14} aria-hidden="true" />
                        </IconButton>
                    </div>
                    {/* Keyed by path: resets the markdown rendered/source toggle per file. */}
                    <FilesPreviewPane
                        key={path}
                        selectedRelPath={path}
                        content={preview.content}
                        block={preview.block}
                        error={preview.error}
                        loading={preview.loading}
                        absPath={absPath}
                        forbidden={preview.forbidden}
                        onGrantAccess={grantAccess}
                    />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
