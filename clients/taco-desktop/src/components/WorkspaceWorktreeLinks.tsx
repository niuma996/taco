import { GitFork } from "lucide-react";
import { useWorktrees, type WorktreesClient } from "../hooks/useWorktrees";
import { useT } from "../i18n/useI18n";
import { lastSegment } from "../lib/workspaceStorage";

export interface WorkspaceWorktreeLinksProps {
    client: WorktreesClient | undefined;
    cwd: string;
    activeCwd: string;
    active: boolean;
    onSelect: (cwd: string) => void;
}

/** Compact worktree navigation nested under the owning conversation group. */
export function WorkspaceWorktreeLinks(props: WorkspaceWorktreeLinksProps) {
    const { t } = useT();
    const inventory = useWorktrees(props.client, props.cwd, props.active);
    const data = inventory.data;
    if (data?.status !== "repository") return null;
    const worktrees = data.worktrees.filter(
        (tree) => tree.managed && tree.path !== data.repository.checkoutRoot,
    );
    if (worktrees.length === 0) return null;
    return (
        <div className="workspace-worktree-links" aria-label={t("worktrees.title")}>
            {worktrees.map((tree) => (
                <button
                    type="button"
                    className="workspace-worktree-link"
                    data-active={tree.path === props.activeCwd}
                    title={tree.path}
                    key={tree.path}
                    onClick={() => props.onSelect(tree.path)}
                >
                    <GitFork size={12} aria-hidden="true" />
                    <span>{lastSegment(tree.path)}</span>
                    {tree.path === props.activeCwd && (
                        <span className="workspace-worktree-link-current">
                            {t("worktrees.current")}
                        </span>
                    )}
                </button>
            ))}
        </div>
    );
}
