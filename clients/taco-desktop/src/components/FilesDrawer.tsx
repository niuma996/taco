/**
 * FilesDrawer — top-level Radix Dialog container that holds useFileTree +
 * useFilePreview. The tree + preview pane render via sub-components; this
 * file only orchestrates:
 *  - activeCwd change → refresh tree + clear preview
 *  - open change → loadRoot once
 *  - Radix Dialog's open/close protocol
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo } from "react";

import { useFilePreview } from "../hooks/useFilePreview";
import { useFileTree } from "../hooks/useFileTree";
import { useT } from "../i18n/useI18n";
import { createFsClient, type FsClient } from "../lib/clients/fsClient";
import { FilesPreviewPane } from "./FilesPreviewPane";
import { FilesTreeView } from "./FilesTreeView";
import { Switch } from "./ui/Switch.tsx";

// Shared between the switch and its visible label so clicking the text
// toggles hidden files, matching the former wrapping <label> behavior.
const showHiddenId = "files-show-hidden-switch";

export interface FilesDrawerProps {
    open: boolean;
    activeCwd: string | null;
    onClose: () => void;
}

export function FilesDrawer(props: FilesDrawerProps) {
    const { open, activeCwd, onClose } = props;
    const { t } = useT();

    // Rebuild fsClient whenever activeCwd changes (the closure captures cwd).
    const fsClient: FsClient | null = useMemo(() => {
        if (!activeCwd) return null;
        return createFsClient(activeCwd);
    }, [activeCwd]);

    const tree = useFileTree(
        // Dummy api while cwd is null; the hook only calls it from effects.
        fsClient ?? { readDir: async () => [], readText: async () => "" },
    );
    const preview = useFilePreview(fsClient ?? { readDir: async () => [], readText: async () => "" });

    // Drawer open / workspace switch → refresh tree + clear preview.
    // Merged into one effect to avoid loadRoot + refresh both firing
    // fetchDir("") on activeCwd change. Skip I/O when open=false so a closed
    // drawer doesn't trigger reads.
    // biome-ignore lint/correctness/useExhaustiveDependencies: tree/preview objects are rebuilt each render and can't go in deps
    useEffect(() => {
        if (!open || !activeCwd || !fsClient) return;
        void tree.refresh();
        preview.clear();
    }, [open, activeCwd, fsClient]);

    // When cwd is null, render a minimal Radix shell. The early return must
    // come after all hooks.
    if (!activeCwd) {
        return (
            <Dialog.Root
                open={open}
                onOpenChange={(next) => {
                    if (!next) onClose();
                }}
            >
                <Dialog.Portal>
                    <Dialog.Overlay className="drawer-backdrop" />
                    <Dialog.Content
                        className={`drawer files-drawer${preview.selectedRelPath ? " files-drawer-with-preview" : ""}`}
                        aria-label={t("files.title")}
                    >
                        <header className="drawer-header">
                            <Dialog.Title className="drawer-title">{t("files.title")}</Dialog.Title>
                            <button
                                type="button"
                                className="drawer-close"
                                onClick={onClose}
                                aria-label={t("app.dismiss")}
                            >
                                ×
                            </button>
                        </header>
                        <div className="files-preview-empty">{t("files.previewEmpty")}</div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        );
    }

    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="drawer-backdrop" />
                <Dialog.Content
                    className={`drawer files-drawer${preview.selectedRelPath ? " files-drawer-with-preview" : ""}`}
                    aria-label={t("files.title")}
                >
                    <header className="drawer-header">
                        <Dialog.Title className="drawer-title">{t("files.title")}</Dialog.Title>
                        <button
                            type="button"
                            className="drawer-close"
                            onClick={onClose}
                            aria-label={t("app.dismiss")}
                        >
                            ×
                        </button>
                    </header>
                    <div className="files-drawer-body">
                        <div className="files-tree-pane">
                            {tree.error && (
                                <div className="files-preview-error">
                                    {t("files.loadError")}: {tree.error}
                                </div>
                            )}
                            <FilesTreeView
                                entriesByDir={tree.entriesByDir}
                                expanded={tree.expanded}
                                selectedRelPath={preview.selectedRelPath}
                                onToggleExpand={(rel) => void tree.toggleExpand(rel)}
                                onSelect={(rel) => void preview.select(rel)}
                            />
                            <div className="files-tree-footer">
                                <Switch
                                    checked={tree.showHidden}
                                    onChange={(next) => void tree.setShowHidden(next)}
                                    label={t("files.showHidden")}
                                    id={showHiddenId}
                                />
                                <label htmlFor={showHiddenId}>{t("files.showHidden")}</label>
                            </div>
                        </div>
                        {preview.selectedRelPath !== null && (
                            <FilesPreviewPane
                                selectedRelPath={preview.selectedRelPath}
                                content={preview.content}
                                binary={preview.binary}
                                truncated={preview.truncated}
                                error={preview.error}
                                loading={preview.loading}
                            />
                        )}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
