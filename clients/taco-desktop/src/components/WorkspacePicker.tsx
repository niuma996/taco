/**
 * WorkspacePicker — topbar workspace dropdown backed by Radix UI DropdownMenu.
 *
 * Trigger shows the active workspace; the menu lists every workspace (current
 * one checked) plus an "open folder…" action at the bottom. Using a menu (not
 * Select) because the row set mixes value items with an action item, which
 * Select's single-value semantics can't express. Falls back to showing only
 * `activeCwd` when the list is empty.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Folder, FolderOpen } from "lucide-react";
import { useT } from "../i18n/useI18n";
import { lastSegment } from "../lib/workspaceStorage";

export interface WorkspacePickerOption {
    cwd: string;
}

export interface WorkspacePickerProps {
    workspaces: WorkspacePickerOption[];
    activeCwd: string;
    onChange: (cwd: string) => void;
    onOpenFolder: () => void;
}

export function WorkspacePicker({
    workspaces,
    activeCwd,
    onChange,
    onOpenFolder,
}: WorkspacePickerProps) {
    const { t } = useT();
    const options = workspaces.length > 0 ? workspaces : [{ cwd: activeCwd }];
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger
                className="topbar-workspace-select"
                title={activeCwd}
                aria-label={t("activity.switchWorkspace")}
            >
                <Folder size={14} aria-hidden="true" className="topbar-workspace-select-icon" />
                <span className="topbar-workspace-select-label">{lastSegment(activeCwd)}</span>
                <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className="topbar-workspace-select-chevron"
                />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="topbar-workspace-menu"
                    sideOffset={4}
                    align="start"
                >
                    {options.map((opt) => (
                        <DropdownMenu.Item
                            key={opt.cwd}
                            className="topbar-workspace-item"
                            onSelect={() => onChange(opt.cwd)}
                        >
                            <span className="topbar-workspace-item-check">
                                {opt.cwd === activeCwd && <Check size={12} aria-hidden="true" />}
                            </span>
                            <span className="topbar-workspace-item-label">
                                {lastSegment(opt.cwd)}
                            </span>
                        </DropdownMenu.Item>
                    ))}
                    <DropdownMenu.Separator className="topbar-workspace-separator" />
                    <DropdownMenu.Item className="topbar-workspace-item" onSelect={onOpenFolder}>
                        <span className="topbar-workspace-item-check">
                            <FolderOpen size={12} aria-hidden="true" />
                        </span>
                        <span className="topbar-workspace-item-label">
                            {t("activity.openFolder")}
                        </span>
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
