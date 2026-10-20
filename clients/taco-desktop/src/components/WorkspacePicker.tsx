/**
 * WorkspacePicker — topbar workspace dropdown backed by Radix UI DropdownMenu.
 *
 * Trigger shows the active workspace; the menu lists every workspace (current
 * one checked) plus an "open folder…" action at the bottom. Using a menu (not
 * Select) because the row set mixes value items with an action item, which
 * Select's single-value semantics can't express. Falls back to showing only
 * `activeCwd` when the list is empty.
 *
 * IM conversations appear in the same list as filesystem directories — the
 * dropdown answers "what am I talking to", and a conversation is the same
 * kind of answer as a project directory. The two are distinguished by a
 * label and an icon, not by living in different menus.
 *
 * Each row carries its own "associated directories…" action, so the entry
 * point sits next to the thing it configures.
 */

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Folder, FolderOpen, Link2, MessageSquare } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n/useI18n";
import { lastSegment } from "../lib/workspaceStorage";

export interface WorkspacePickerOption {
    cwd: string;
    /** Display name. Defaults to the path's last segment. */
    label?: string;
    /** True for an IM conversation — rendered with a different icon. */
    isIm?: boolean;
}

export interface WorkspacePickerProps {
    workspaces: WorkspacePickerOption[];
    activeCwd: string;
    onChange: (cwd: string) => void;
    onOpenFolder: () => void;
    /** Open the associated-directories editor for a workspace. */
    onManageAssociations?: (cwd: string) => void;
}

export function WorkspacePicker({
    workspaces,
    activeCwd,
    onChange,
    onOpenFolder,
    onManageAssociations,
}: WorkspacePickerProps) {
    const { t } = useT();
    // Controlled so the per-row association action can close the menu before
    // opening the dialog — a modal over an open menu leaves two floating
    // surfaces stacked.
    const [open, setOpen] = useState(false);
    const options = workspaces.length > 0 ? workspaces : [{ cwd: activeCwd }];
    return (
        <DropdownMenu.Root open={open} onOpenChange={setOpen}>
            <DropdownMenu.Trigger
                className="topbar-workspace-select"
                title={activeCwd}
                aria-label={t("activity.switchWorkspace")}
            >
                <Folder size={14} aria-hidden="true" className="topbar-workspace-select-icon" />
                <span className="topbar-workspace-select-label">
                    {options.find((o) => o.cwd === activeCwd)?.label ?? lastSegment(activeCwd)}
                </span>
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
                                {opt.cwd === activeCwd ? (
                                    <Check size={12} aria-hidden="true" />
                                ) : opt.isIm ? (
                                    <MessageSquare size={12} aria-hidden="true" />
                                ) : null}
                            </span>
                            <span className="topbar-workspace-item-label">
                                {opt.label ?? lastSegment(opt.cwd)}
                            </span>
                            {onManageAssociations && (
                                <button
                                    type="button"
                                    className="topbar-workspace-item-action"
                                    aria-label={t("activity.manageAssociations")}
                                    title={t("activity.manageAssociations")}
                                    tabIndex={-1}
                                    onClick={(e) => {
                                        // Not a select: the row still switches
                                        // the workspace; this button opens the
                                        // association editor instead.
                                        e.stopPropagation();
                                        e.preventDefault();
                                        setOpen(false);
                                        onManageAssociations(opt.cwd);
                                    }}
                                >
                                    <Link2 size={12} aria-hidden="true" />
                                </button>
                            )}
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
