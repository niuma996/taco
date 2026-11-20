import { asWorkspaceId, type GitWorktreeInfo, type WorktreeBase } from "@taco-ai/protocol";
import { GitBranch, GitFork, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { ConfirmModal } from "../components/ConfirmModal";
import { Button } from "../components/ui/Button";
import { FormField } from "../components/ui/FormField";
import { IconButton } from "../components/ui/IconButton";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { TextInput } from "../components/ui/TextInput";
import { WorkspaceGitStatus } from "../components/WorkspaceGitStatus";
import { useWorktrees, type WorktreesClient } from "../hooks/useWorktrees";
import { useT } from "../i18n/useI18n";
import type { TacoClient } from "../lib/clients/tacoClient";
import { queryError } from "../lib/queries/queryClient";

type WorktreesClientWithActions = WorktreesClient &
    Pick<TacoClient, "worktreeCreate" | "worktreeRemove" | "gitInspect" | "gitInit">;

export interface WorktreesPaneProps {
    client: WorktreesClientWithActions;
    cwd: string;
    activeCwd: string;
    onOpenWorkspace: (cwd: string) => void;
}

export function WorktreesPane({ client, cwd, activeCwd, onOpenWorkspace }: WorktreesPaneProps) {
    const { t } = useT();
    const inventory = useWorktrees(client, cwd);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [base, setBase] = useState<WorktreeBase>("head");
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<GitWorktreeInfo | null>(null);
    const [removeBusy, setRemoveBusy] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const result = inventory.data;
    const repository = result?.status === "repository" ? result.repository : null;
    const worktrees = result?.status === "repository" ? result.worktrees : [];

    function openCreate() {
        setName("");
        setBase("head");
        setCreateError(null);
        setCreating(true);
    }

    async function create() {
        const trimmed = name.trim();
        if (!trimmed || createBusy) return;
        setCreateBusy(true);
        setCreateError(null);
        try {
            const created = await client.worktreeCreate({
                workspace: asWorkspaceId(cwd),
                name: trimmed,
                base,
            });
            setCreating(false);
            onOpenWorkspace(created.path);
            await inventory.refresh();
        } catch (cause) {
            setCreateError(queryError(cause)?.message ?? String(cause));
        } finally {
            setCreateBusy(false);
        }
    }

    async function remove() {
        if (!removing || removeBusy) return;
        setRemoveBusy(true);
        setRemoveError(null);
        try {
            await client.worktreeRemove({ workspace: asWorkspaceId(cwd), path: removing.path });
            const returnTo = removing.path === activeCwd ? repository?.checkoutRoot : null;
            setRemoving(null);
            if (returnTo) onOpenWorkspace(returnTo);
            await inventory.refresh();
        } catch (cause) {
            setRemoveError(queryError(cause)?.message ?? String(cause));
        } finally {
            setRemoveBusy(false);
        }
    }

    function navigate(event: KeyboardEvent<HTMLUListElement>) {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const rows = Array.from(
            listRef.current?.querySelectorAll<HTMLButtonElement>("[data-worktree-open]") ?? [],
        );
        if (rows.length === 0) return;
        event.preventDefault();
        const current = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : Math.max(
                        0,
                        Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
                    );
        rows[next]?.focus();
    }

    return (
        <div className="worktrees-pane">
            <div className="pane-header">
                <div className="pane-header-title">
                    <GitFork size={16} aria-hidden="true" />
                    {t("worktrees.title")}
                    {repository && <span className="pane-count-badge">{worktrees.length}</span>}
                </div>
                <div className="pane-header-actions">
                    <IconButton
                        aria-label={t("worktrees.refresh")}
                        title={t("worktrees.refresh")}
                        disabled={inventory.refreshing}
                        onClick={() => void inventory.refresh()}
                    >
                        <RefreshCw size={14} aria-hidden="true" />
                    </IconButton>
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={!repository || repository.isBare}
                        onClick={openCreate}
                    >
                        <Plus size={14} aria-hidden="true" />
                        {t("worktrees.create")}
                    </Button>
                </div>
            </div>
            {result && result.status !== "repository" && (
                <WorkspaceGitStatus client={client} cwd={cwd} />
            )}
            {inventory.error && (
                <div className="pane-error" role="alert">
                    {t("worktrees.loadFailed", { error: inventory.error })}
                </div>
            )}
            {inventory.loading ? (
                <div className="pane-empty">{t("worktrees.loading")}</div>
            ) : (
                repository &&
                (worktrees.length === 0 ? (
                    <div className="pane-empty">{t("worktrees.empty")}</div>
                ) : (
                    <ul className="worktrees-list" ref={listRef} onKeyDown={navigate}>
                        {worktrees.map((tree) => {
                            const primary = tree.path === repository.checkoutRoot;
                            const label = primary
                                ? t("worktrees.local")
                                : (tree.branch ?? tree.headOid?.slice(0, 7) ?? tree.path);
                            return (
                                <li
                                    className="worktree-item"
                                    key={tree.path}
                                    data-current={tree.path === activeCwd}
                                >
                                    <button
                                        type="button"
                                        className="worktree-open"
                                        data-worktree-open={tree.path}
                                        aria-label={`${t("worktrees.open")} ${label}`}
                                        onClick={() => onOpenWorkspace(tree.path)}
                                    >
                                        <GitBranch size={15} aria-hidden="true" />
                                        <span className="worktree-copy">
                                            <span className="worktree-name">{label}</span>
                                            <span className="worktree-path" title={tree.path}>
                                                {tree.path}
                                            </span>
                                        </span>
                                        {tree.path === activeCwd && (
                                            <span className="worktree-current">
                                                {t("worktrees.current")}
                                            </span>
                                        )}
                                    </button>
                                    {tree.locked && (
                                        <span className="worktree-state" title={tree.lockReason}>
                                            {t("worktrees.locked")}
                                        </span>
                                    )}
                                    {!primary && tree.managed && (
                                        <IconButton
                                            aria-label={`${t("worktrees.remove")} ${label}`}
                                            title={
                                                tree.locked
                                                    ? tree.lockReason
                                                    : t("worktrees.remove")
                                            }
                                            tone="danger"
                                            disabled={tree.locked}
                                            onClick={() => {
                                                setRemoving(tree);
                                                setRemoveError(null);
                                            }}
                                        >
                                            <Trash2 size={14} aria-hidden="true" />
                                        </IconButton>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                ))
            )}
            <Modal
                open={creating}
                onClose={() => setCreating(false)}
                dismissible={!createBusy}
                title={t("worktrees.createTitle")}
                description={t("worktrees.createDescription")}
                actions={
                    <>
                        <Button
                            variant="ghost"
                            disabled={createBusy}
                            onClick={() => setCreating(false)}
                        >
                            {t("worktrees.cancel")}
                        </Button>
                        <Button
                            variant="primary"
                            disabled={!name.trim() || createBusy}
                            onClick={() => void create()}
                        >
                            {createBusy ? t("worktrees.creating") : t("worktrees.createConfirm")}
                        </Button>
                    </>
                }
            >
                <FormField label={t("worktrees.name")}>
                    <TextInput
                        id="worktree-name"
                        value={name}
                        maxLength={80}
                        disabled={createBusy}
                        onChange={(event) => setName(event.target.value)}
                    />
                </FormField>
                <FormField label={t("worktrees.base")} hint={t("worktrees.baseHint")}>
                    <Select
                        value={base}
                        onValueChange={(value) => setBase(value as WorktreeBase)}
                        options={[
                            { value: "head", label: t("worktrees.baseHead") },
                            { value: "default", label: t("worktrees.baseDefault") },
                        ]}
                        disabled={createBusy}
                    />
                </FormField>
                {createError && (
                    <div className="error-banner" role="alert">
                        {createError}
                    </div>
                )}
            </Modal>
            <ConfirmModal
                open={removing !== null}
                title={t("worktrees.removeTitle")}
                message={t("worktrees.removeDescription", { path: removing?.path ?? "" })}
                confirmLabel={removeBusy ? t("worktrees.removing") : t("worktrees.removeConfirm")}
                cancelLabel={t("worktrees.cancel")}
                tone="danger"
                busy={removeBusy}
                error={removeError}
                onCancel={() => setRemoving(null)}
                onConfirm={() => void remove()}
            />
        </div>
    );
}
