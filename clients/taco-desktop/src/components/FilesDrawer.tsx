/**
 * FilesDrawer — inline right-side panel holding useFileTree. A flex sibling
 * inside .layout (same layer as TaskPanel), not a modal overlay: the chat
 * area stays interactive while the panel is open.
 *
 * File preview is a floating popup (Radix Dialog) rather than an inline
 * pane: the tree panel keeps its 280px width, and the preview gets a wide
 * centered window without squeezing the chat column.
 *
 * This file only orchestrates:
 *  - activeCwd change → refresh tree + clear preview
 *  - open change → loadRoot once
 */
import * as Dialog from "@radix-ui/react-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { FolderOpen, X } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { DragHandleProps } from "../hooks/primitives/useDragResize";
import { useFilePreview } from "../hooks/useFilePreview";
import { useFileTree } from "../hooks/useFileTree";
import { useT } from "../i18n/useI18n";
import { createFsClient, type FsClient, resolveFsPath } from "../lib/clients/fsClient";
import { lastSegment } from "../lib/workspaceStorage";
import { FilesPreviewPane } from "./FilesPreviewPane";
import { FilesTreeView } from "./FilesTreeView";
import { RightPanel } from "./panels/RightPanel";
import { Switch } from "./ui/Switch.tsx";

// Shared between the switch and its visible label so clicking the text
// toggles hidden files, matching the former wrapping <label> behavior.
const showHiddenId = "files-show-hidden-switch";

export interface FilesDrawerProps {
    open: boolean;
    activeCwd: string | null;
    onClose: () => void;
    resizeHandleProps?: DragHandleProps;
    resizeLabel?: string;
}

export function FilesDrawer(props: FilesDrawerProps) {
    const { open, activeCwd, onClose, resizeHandleProps, resizeLabel } = props;
    const { t } = useT();

    // Rebuild fsClient whenever activeCwd changes (the closure captures cwd).
    const fsClient: FsClient | null = useMemo(() => {
        if (!activeCwd) return null;
        return createFsClient(activeCwd);
    }, [activeCwd]);

    const tree = useFileTree(
        // Dummy api while cwd is null; the hook only calls it from effects.
        fsClient ?? {
            readDir: async () => [],
            readText: async () => "",
            readBinary: async () => new Uint8Array(),
            sizeOf: async () => 0,
        },
    );
    const preview = useFilePreview(
        fsClient ?? {
            readDir: async () => [],
            readText: async () => "",
            readBinary: async () => new Uint8Array(),
            sizeOf: async () => 0,
        },
    );

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

    // Early return after hooks: a closed panel renders nothing but keeps
    // tree/preview state alive for the next open.
    if (!open) return null;

    return (
        <>
            <RightPanel
                title={t("files.title")}
                onClose={onClose}
                closeLabel={t("app.dismiss")}
                className="files-drawer"
                resizeHandleProps={resizeHandleProps}
                resizeLabel={resizeLabel}
                actions={
                    activeCwd && (
                        <button
                            type="button"
                            className="right-panel-icon-btn"
                            onClick={() => {
                                // openPath on a directory opens it in the OS file
                                // manager (Finder/Explorer), so the user lands
                                // on the workspace's contents directly.
                                void openPath(activeCwd).catch((err: unknown) => {
                                    console.error("[taco] open workspace failed", err);
                                });
                            }}
                            aria-label={t("files.revealWorkspace")}
                            title={t("files.revealWorkspace")}
                        >
                            <FolderOpen size={14} aria-hidden="true" />
                        </button>
                    )
                }
            >
                {!activeCwd ? (
                    // files-drawer-body gives the empty state a flex:1 base so its
                    // height:100% centering resolves against a stable height.
                    <div className="files-drawer-body">
                        <div className="files-preview-empty">{t("files.previewEmpty")}</div>
                    </div>
                ) : (
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
                    </div>
                )}
            </RightPanel>
            {preview.selectedRelPath !== null && activeCwd !== null && (
                <Dialog.Root
                    open
                    onOpenChange={(next) => {
                        if (!next) preview.clear();
                    }}
                >
                    <Dialog.Portal>
                        <Dialog.Overlay className="files-preview-backdrop" />
                        <Dialog.Content
                            className="files-preview-popup"
                            aria-label={preview.selectedRelPath}
                        >
                            <div className="right-panel-topbar">
                                <Dialog.Title asChild>
                                    <h3 className="right-panel-title">
                                        {lastSegment(preview.selectedRelPath)}
                                    </h3>
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
                                key={preview.selectedRelPath}
                                selectedRelPath={preview.selectedRelPath}
                                content={preview.content}
                                block={preview.block}
                                error={preview.error}
                                loading={preview.loading}
                                absPath={resolveFsPath(activeCwd, preview.selectedRelPath)}
                            />
                        </Dialog.Content>
                    </Dialog.Portal>
                </Dialog.Root>
            )}
        </>
    );
}
