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
import { openUrl } from "@tauri-apps/plugin-opener";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { DragHandleProps } from "../hooks/primitives/useDragResize";
import { useFilePreview } from "../hooks/useFilePreview";
import { useFileTree } from "../hooks/useFileTree";
import { type GitWorkspaceClient, useGitWorkspace } from "../hooks/useGitWorkspace";
import { useT } from "../i18n/useI18n";
import { createFsClient, type FsClient } from "../lib/clients/fsClient";
import { fileUrl } from "../lib/fileUrl";
import { FilePreviewPopup } from "./FilePreviewPopup";
import { FilesTreeView, type FilesTreeViewProps } from "./FilesTreeView";
import { RightPanel } from "./panels/RightPanel";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton.tsx";
import { Switch } from "./ui/Switch.tsx";

// Shared between the switch and its visible label so clicking the text
// toggles hidden files, matching the former wrapping <label> behavior.
const showHiddenId = "files-show-hidden-switch";

export interface FilesDrawerProps {
    client?: GitWorkspaceClient;
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
                        <>
                            <IconButton
                                onClick={() => {
                                    preview.clear();
                                    void tree.refresh();
                                }}
                                aria-label={t("git.refreshFiles")}
                                title={t("git.refreshFiles")}
                            >
                                <RefreshCw size={14} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                                onClick={() => {
                                    // A file:// URL for a directory lands in the OS
                                    // file manager (Finder/Explorer), so the user
                                    // sees the workspace's contents directly.
                                    void openUrl(fileUrl(activeCwd)).catch((err: unknown) => {
                                        console.error("[taco] open workspace failed", err);
                                    });
                                }}
                                aria-label={t("files.revealWorkspace")}
                                title={t("files.revealWorkspace")}
                            >
                                <FolderOpen size={14} aria-hidden="true" />
                            </IconButton>
                        </>
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
                                <div className="files-preview-error" role="alert">
                                    {t("files.loadError")}: {tree.error}
                                </div>
                            )}
                            <WorkspaceFilesTree
                                client={props.client}
                                cwd={activeCwd}
                                onClearPreview={preview.clear}
                                showHidden={tree.showHidden}
                                entriesByDir={tree.entriesByDir}
                                expanded={tree.expanded}
                                selectedRelPath={preview.selectedRelPath}
                                onToggleExpand={(rel, skipRead) =>
                                    void tree.toggleExpand(rel, skipRead)
                                }
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
            {activeCwd !== null && <FilePreviewPopup preview={preview} cwd={activeCwd} />}
        </>
    );
}

interface WorkspaceFilesTreeProps extends FilesTreeViewProps {
    onToggleExpand: (rel: string, skipRead?: boolean) => void;
    client?: GitWorkspaceClient;
    cwd: string;
    onClearPreview: () => void;
}

// Keep the no-client tree independent of QueryClientProvider for existing embeds.
function WorkspaceFilesTree(props: WorkspaceFilesTreeProps) {
    if (!props.client) return <FilesTreeView {...props} />;
    return <GitFilesTree {...props} client={props.client} />;
}

function GitFilesTree({
    client,
    cwd,
    onClearPreview,
    ...props
}: WorkspaceFilesTreeProps & { client: GitWorkspaceClient }) {
    const { t } = useT();
    const git = useGitWorkspace(client, cwd);
    const changes = git.data?.status === "repository" ? git.data.changes : undefined;
    const selectedDeleted = changes?.some(
        (change) => change.path === props.selectedRelPath && change.kind === "deleted",
    );
    useEffect(() => {
        if (selectedDeleted) onClearPreview();
    }, [selectedDeleted, onClearPreview]);
    return (
        <>
            {git.loading && (
                <div className="files-git-status" role="status">
                    {t("git.loading")}
                </div>
            )}
            {git.error && (
                <div className="files-git-status" role="alert">
                    <span>{t("git.inspectFailed", { error: git.error })}</span>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={git.refreshing}
                        onClick={() => void git.refresh()}
                    >
                        {t("git.retry")}
                    </Button>
                </div>
            )}
            <FilesTreeView
                {...props}
                gitChanges={changes}
                onToggleExpand={(rel) => {
                    const descendants = changes?.filter((change) =>
                        change.path.startsWith(`${rel}/`),
                    );
                    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
                    const existsInSnapshot = props.entriesByDir
                        .get(parent)
                        ?.some((entry) => entry.relPath === rel && entry.kind === "dir");
                    const deletedDirectory = Boolean(
                        !existsInSnapshot &&
                            descendants?.length &&
                            descendants.every((change) => change.kind === "deleted"),
                    );
                    props.onToggleExpand(rel, deletedDirectory);
                }}
            />
        </>
    );
}
