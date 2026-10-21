/**
 * WorkspacePicker — topbar workspace dropdown backed by Radix UI DropdownMenu.
 *
 * Trigger shows the active workspace; the menu lists the workspaces of one
 * kind (current one checked). Using a menu (not Select) because the row set
 * mixes value items with an action item, which Select's single-value
 * semantics can't express. Falls back to showing only `activeCwd` when the
 * list is empty.
 *
 * The kind is chosen by WorkspaceModeTabs in front of the picker: project
 * directories, or IM channel conversations. Conversation rows name their
 * source channel, and the "open folder…" action is offered only for
 * directories — a conversation is created by inbound messages, not by
 * picking a path.
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
    /** Source channel of an IM conversation, shown after the label. */
    channel?: string;
}

export interface WorkspacePickerProps {
    workspaces: WorkspacePickerOption[];
    activeCwd: string;
    /** Which kind of workspace the list holds. */
    mode: "workspace" | "im";
    onChange: (cwd: string) => void;
    onOpenFolder: () => void;
    /** Open the associated-directories editor for a workspace. */
    onManageAssociations?: (cwd: string) => void;
}

export function WorkspacePicker({
    workspaces,
    activeCwd,
    mode,
    onChange,
    onOpenFolder,
    onManageAssociations,
}: WorkspacePickerProps) {
    const { t } = useT();
    // Controlled so the per-row association action can close the menu before
    // opening the dialog — a modal over an open menu leaves two floating
    // surfaces stacked.
    const [open, setOpen] = useState(false);
    const isIm = mode === "im";
    const options = workspaces.length > 0 ? workspaces : [{ cwd: activeCwd }];
    const TriggerIcon = isIm ? MessageSquare : Folder;
    return (
        <DropdownMenu.Root open={open} onOpenChange={setOpen}>
            <DropdownMenu.Trigger
                className="topbar-workspace-select"
                title={activeCwd}
                aria-label={t("activity.switchWorkspace")}
            >
                <TriggerIcon
                    size={14}
                    aria-hidden="true"
                    className="topbar-workspace-select-icon"
                />
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
                                {opt.cwd === activeCwd && <Check size={12} aria-hidden="true" />}
                            </span>
                            <span className="topbar-workspace-item-label">
                                {opt.label ?? lastSegment(opt.cwd)}
                            </span>
                            {opt.channel && (
                                <span className="topbar-workspace-item-channel">{opt.channel}</span>
                            )}
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
                    {!isIm && (
                        <>
                            <DropdownMenu.Separator className="topbar-workspace-separator" />
                            <DropdownMenu.Item
                                className="topbar-workspace-item"
                                onSelect={onOpenFolder}
                            >
                                <span className="topbar-workspace-item-check">
                                    <FolderOpen size={12} aria-hidden="true" />
                                </span>
                                <span className="topbar-workspace-item-label">
                                    {t("activity.openFolder")}
                                </span>
                            </DropdownMenu.Item>
                        </>
                    )}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
