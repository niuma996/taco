/**
 * FilesTreeView — recursive directory-tree renderer.
 *
 * Indent is driven by the CSS variable `--depth` (0.85rem per level, hard
 * cap 8).
 */
import type { GitFileChange } from "@taco-ai/protocol";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useMemo } from "react";
import { useT } from "../i18n/useI18n";
import type { DirectoryListing, FileEntry } from "../lib/fileTypes";
import { gitFileTree, gitStatusLetter, gitStatusTone } from "../lib/gitFileTree";
import { IconSwap } from "./ui/IconSwap.tsx";

const MAX_DEPTH = 8;

export interface FilesTreeViewProps {
    gitChanges?: readonly GitFileChange[];
    showHidden?: boolean;
    entriesByDir: DirectoryListing;
    expanded: ReadonlySet<string>;
    selectedRelPath: string | null;
    onToggleExpand: (relPath: string) => void;
    onSelect: (relPath: string) => void;
}

export function FilesTreeView(props: FilesTreeViewProps) {
    const merged = useMemo(
        () => gitFileTree(props.entriesByDir, props.gitChanges ?? [], props.showHidden ?? false),
        [props.entriesByDir, props.gitChanges, props.showHidden],
    );
    return (
        <div
            className="files-tree-root"
            role="tree"
            tabIndex={0}
            onKeyDown={(event) => {
                // Rows handle their own keys; only act when the tree root itself is focused.
                if (event.target !== event.currentTarget) return;
                if (event.key !== "ArrowDown" && event.key !== "Enter") return;
                event.preventDefault();
                event.currentTarget
                    .querySelector<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])')
                    ?.focus();
            }}
        >
            <TreeRows
                rel=""
                depth={0}
                {...props}
                entriesByDir={merged.entriesByDir}
                statuses={merged.statuses}
            />
        </div>
    );
}

interface TreeRowsProps extends FilesTreeViewProps {
    rel: string;
    depth: number;
    statuses: ReadonlyMap<string, GitFileChange>;
}

function TreeRows(props: TreeRowsProps) {
    const { rel, depth, entriesByDir, expanded, selectedRelPath, onToggleExpand, onSelect } = props;
    const entries = entriesByDir.get(rel);
    if (!entries) return null;

    return (
        <>
            {entries.map((entry) => (
                <TreeRow
                    key={entry.relPath}
                    statuses={props.statuses}
                    entry={entry}
                    depth={depth}
                    entriesByDir={entriesByDir}
                    expanded={expanded}
                    selectedRelPath={selectedRelPath}
                    onToggleExpand={onToggleExpand}
                    onSelect={onSelect}
                />
            ))}
        </>
    );
}

interface TreeRowProps {
    statuses: ReadonlyMap<string, GitFileChange>;
    entry: FileEntry;
    depth: number;
    entriesByDir: DirectoryListing;
    expanded: ReadonlySet<string>;
    selectedRelPath: string | null;
    onToggleExpand: (relPath: string) => void;
    onSelect: (relPath: string) => void;
}

function TreeRow({
    statuses,
    entry,
    depth,
    entriesByDir,
    expanded,
    selectedRelPath,
    onToggleExpand,
    onSelect,
}: TreeRowProps) {
    const { t } = useT();
    const change = statuses.get(entry.relPath);
    const isDeleted = entry.kind === "file" && change?.kind === "deleted";
    const isDir = entry.kind === "dir";
    const statusLabel = change ? t(isDir ? "git.folderChanges" : `git.${change.kind}`) : null;
    const statusLetter = change
        ? isDir && change.kind !== "conflict"
            ? "M"
            : gitStatusLetter(change)
        : null;
    const title = [
        entry.relPath,
        statusLabel,
        !isDir && change?.originalPath ? `${t("git.renamedFrom")}: ${change.originalPath}` : null,
        isDeleted ? t("git.deletedNoPreview") : null,
    ]
        .filter(Boolean)
        .join(" · ");
    const isExpanded = isDir && expanded.has(entry.relPath);
    const isActive = selectedRelPath === entry.relPath;
    const cappedDepth = Math.min(depth, MAX_DEPTH);

    function handleClick() {
        if (isDeleted) return;
        if (isDir) {
            onToggleExpand(entry.relPath);
        } else {
            onSelect(entry.relPath);
        }
    }

    return (
        <>
            <div
                className="files-tree-row"
                role="treeitem"
                tabIndex={-1}
                aria-label={title}
                aria-disabled={isDeleted || undefined}
                data-git-tone={change ? gitStatusTone(change) : undefined}
                data-deleted={isDeleted || undefined}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleClick();
                    } else if (
                        isDir &&
                        ((event.key === "ArrowRight" && !isExpanded) ||
                            (event.key === "ArrowLeft" && isExpanded))
                    ) {
                        event.preventDefault();
                        onToggleExpand(entry.relPath);
                    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const tree = event.currentTarget.closest('[role="tree"]');
                        if (!tree) return;
                        const rows = Array.from(
                            tree.querySelectorAll<HTMLElement>(
                                '[role="treeitem"]:not([aria-disabled="true"])',
                            ),
                        );
                        const index = rows.indexOf(event.currentTarget);
                        rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
                    }
                }}
                aria-expanded={isDir ? isExpanded : undefined}
                aria-selected={!isDir ? isActive : undefined}
                data-active={isActive}
                style={{ ["--depth" as string]: cappedDepth } as React.CSSProperties}
                onClick={handleClick}
                title={title}
            >
                {isDir ? (
                    <span
                        className="files-tree-row-toggle"
                        data-open={isExpanded}
                        aria-hidden="true"
                    >
                        <ChevronRight size={12} />
                    </span>
                ) : (
                    <span className="files-tree-row-toggle-spacer" aria-hidden="true" />
                )}
                <span className="files-tree-row-icon" aria-hidden="true">
                    {isDir ? (
                        <IconSwap
                            icons={[
                                <Folder size={14} key="closed" />,
                                <FolderOpen size={14} key="open" />,
                            ]}
                            active={isExpanded ? 1 : 0}
                        />
                    ) : (
                        <File size={14} />
                    )}
                </span>
                <span className="files-tree-row-name">{entry.name}</span>
                {change && (
                    <span
                        className="files-tree-row-status"
                        title={statusLabel ?? undefined}
                        aria-hidden="true"
                    >
                        {statusLetter}
                    </span>
                )}
            </div>
            {isDir && isExpanded && (
                <TreeRows
                    statuses={statuses}
                    rel={entry.relPath}
                    depth={depth + 1}
                    entriesByDir={entriesByDir}
                    expanded={expanded}
                    selectedRelPath={selectedRelPath}
                    onToggleExpand={onToggleExpand}
                    onSelect={onSelect}
                />
            )}
        </>
    );
}
