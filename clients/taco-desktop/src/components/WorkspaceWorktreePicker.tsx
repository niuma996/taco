import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Folder, GitFork, Settings2 } from "lucide-react";
import { useWorktrees, type WorktreesClient } from "../hooks/useWorktrees";
import { useT } from "../i18n/useI18n";
import { lastSegment } from "../lib/workspaceStorage";

export interface WorkspaceWorktreePickerProps {
    client: WorktreesClient;
    cwd: string;
    onSelect: (cwd: string) => void;
    onManage: () => void;
}

/** Switches a new chat between its main checkout and the repository's worktrees. */
export function WorkspaceWorktreePicker(props: WorkspaceWorktreePickerProps) {
    const { t } = useT();
    const inventory = useWorktrees(props.client, props.cwd);
    const data = inventory.data;
    if (data?.status !== "repository" || data.repository.isBare) return null;
    const worktrees = data.worktrees;
    const local = props.cwd === data.repository.checkoutRoot;
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    type="button"
                    className="workspace-worktree-picker"
                    aria-label={t("worktrees.switch")}
                    title={props.cwd}
                >
                    {local ? (
                        <Folder size={13} aria-hidden="true" />
                    ) : (
                        <GitFork size={13} aria-hidden="true" />
                    )}
                    <span>{local ? t("worktrees.local") : lastSegment(props.cwd)}</span>
                    <ChevronDown size={12} aria-hidden="true" />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="ui-menu"
                    side="top"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                >
                    <DropdownMenu.RadioGroup value={props.cwd} onValueChange={props.onSelect}>
                        {worktrees.map((tree) => {
                            const isLocal = tree.path === data.repository.checkoutRoot;
                            const label = isLocal
                                ? t("worktrees.local")
                                : (tree.branch ?? lastSegment(tree.path));
                            return (
                                <DropdownMenu.RadioItem
                                    className="ui-menu-item"
                                    value={tree.path}
                                    key={tree.path}
                                >
                                    {isLocal ? (
                                        <Folder size={14} aria-hidden="true" />
                                    ) : (
                                        <GitFork size={14} aria-hidden="true" />
                                    )}
                                    <span className="ui-menu-label" title={tree.path}>
                                        {label}
                                    </span>
                                    {tree.path === props.cwd && (
                                        <Check size={14} aria-hidden="true" />
                                    )}
                                </DropdownMenu.RadioItem>
                            );
                        })}
                    </DropdownMenu.RadioGroup>
                    <DropdownMenu.Separator className="ui-menu-separator" />
                    <DropdownMenu.Item className="ui-menu-item" onSelect={props.onManage}>
                        <Settings2 size={14} aria-hidden="true" />
                        <span className="ui-menu-label">{t("worktrees.manage")}</span>
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
