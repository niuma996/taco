/**
 * FilesTreeView — recursive directory-tree renderer.
 *
 * Indent is driven by the CSS variable `--depth` (0.85rem per level, hard
 * cap 8).
 */
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";

import type { DirectoryListing, FileEntry } from "../lib/fileTypes";

const MAX_DEPTH = 8;

export interface FilesTreeViewProps {
    entriesByDir: DirectoryListing;
    expanded: ReadonlySet<string>;
    selectedRelPath: string | null;
    onToggleExpand: (relPath: string) => void;
    onSelect: (relPath: string) => void;
}

export function FilesTreeView(props: FilesTreeViewProps) {
    return (
        <div className="files-tree-root" role="tree">
            <TreeRows rel="" depth={0} {...props} />
        </div>
    );
}

interface TreeRowsProps extends FilesTreeViewProps {
    rel: string;
    depth: number;
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
    entry: FileEntry;
    depth: number;
    entriesByDir: DirectoryListing;
    expanded: ReadonlySet<string>;
    selectedRelPath: string | null;
    onToggleExpand: (relPath: string) => void;
    onSelect: (relPath: string) => void;
}

function TreeRow({
    entry,
    depth,
    entriesByDir,
    expanded,
    selectedRelPath,
    onToggleExpand,
    onSelect,
}: TreeRowProps) {
    const isDir = entry.kind === "dir";
    const isExpanded = isDir && expanded.has(entry.relPath);
    const isActive = selectedRelPath === entry.relPath;
    const cappedDepth = Math.min(depth, MAX_DEPTH);

    function handleClick() {
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
                aria-expanded={isDir ? isExpanded : undefined}
                aria-selected={!isDir ? isActive : undefined}
                data-active={isActive}
                style={{ ["--depth" as string]: cappedDepth } as React.CSSProperties}
                onClick={handleClick}
                title={entry.relPath}
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
                        isExpanded ? (
                            <FolderOpen size={14} />
                        ) : (
                            <Folder size={14} />
                        )
                    ) : (
                        <File size={14} />
                    )}
                </span>
                <span className="files-tree-row-name">{entry.name}</span>
            </div>
            {isDir && isExpanded && (
                <TreeRows
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
