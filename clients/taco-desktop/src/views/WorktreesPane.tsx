import { asWorkspaceId, type GitWorktreeInfo, type WorktreeBase } from "@taco-ai/protocol";
import { GitBranch, GitFork, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
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
import { clientQueryKey, queryError } from "../lib/queries/queryClient";
import { mainWorktreePath, navigationWorktrees, worktreeAvailable } from "../lib/worktrees";

type WorktreesClientWithActions = WorktreesClient &
    Pick<TacoClient, "worktreeCreate" | "worktreeRemove" | "gitInspect" | "gitInit">;

export interface WorktreesPaneProps {
    client: WorktreesClientWithActions;
    cwd: string | null;
    activeCwd: string;
    onOpenFolder?: () => void;
    onOpenWorkspace: (cwd: string) => void;
}

export function WorktreesPane(props: WorktreesPaneProps) {
    const { t } = useT();
    if (!props.cwd) {
        return (
            <div className="worktrees-pane worktrees-pane-empty-scope">
                <div className="pane-empty">
                    <GitFork size={24} aria-hidden="true" />
                    <p>{t("worktrees.noLocalWorkspace")}</p>
                    {props.onOpenFolder && (
                        <Button size="sm" variant="primary" onClick={props.onOpenFolder}>
                            {t("worktrees.openLocalWorkspace")}
                        </Button>
                    )}
                </div>
            </div>
        );
    }
    return (
        <WorktreesPaneContent
            key={JSON.stringify([...clientQueryKey(props.client), props.cwd, props.activeCwd])}
            {...props}
            cwd={props.cwd}
        />
    );
}

function WorktreesPaneContent({
    client,
    cwd,
    activeCwd,
    onOpenWorkspace,
}: WorktreesPaneProps & { cwd: string }) {
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
    const worktrees = result?.status === "repository" ? navigationWorktrees(result) : [];
    const mainPath = result?.status === "repository" ? mainWorktreePath(result) : null;
    const current = useRef(false);
    useEffect(() => {
        current.current = true;
        return () => {
            current.current = false;
        };
    }, []);

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
            if (!current.current) return;
            setCreating(false);
            onOpenWorkspace(created.path);
            await inventory.refresh();
        } catch (cause) {
            if (current.current) setCreateError(queryError(cause)?.message ?? String(cause));
        } finally {
            if (current.current) setCreateBusy(false);
        }
    }

    async function remove() {
        if (!removing || removeBusy) return;
        setRemoveBusy(true);
        setRemoveError(null);
        try {
            await client.worktreeRemove({
                workspace: asWorkspaceId(cwd),
                path: removing.path,
                ...(removing.stale ? { forgetMissing: true } : {}),
            });
            if (!current.current) return;
            const removingCurrent =
                removing.path === activeCwd ||
                (cwd === activeCwd && removing.path === repository?.checkoutRoot);
            const returnTo = removingCurrent ? mainPath : null;
            setRemoving(null);
            if (returnTo && returnTo !== removing.path) onOpenWorkspace(returnTo);
            if (removing.path !== repository?.checkoutRoot) await inventory.refresh();
        } catch (cause) {
            if (current.current) setRemoveError(queryError(cause)?.message ?? String(cause));
        } finally {
            if (current.current) setRemoveBusy(false);
        }
    }

    function navigate(event: KeyboardEvent<HTMLUListElement>) {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const rows = Array.from(
            listRef.current?.querySelectorAll<HTMLButtonElement>(
                "[data-worktree-open]:not(:disabled)",
            ) ?? [],
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
                        disabled={!repository?.headOid || repository.isBare}
                        title={
                            repository && !repository.headOid
                                ? t("worktrees.commitFirst")
                                : undefined
                        }
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
                            const primary = tree.path === mainPath;
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
                                        disabled={!worktreeAvailable(tree)}
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
                                    {!worktreeAvailable(tree) && (
                                        <span className="worktree-state" title={tree.pruneReason}>
                                            {t(tree.bare ? "git.bare" : "worktrees.unavailable")}
                                        </span>
                                    )}
                                    {!primary && (tree.managed || tree.stale) && (
                                        <IconButton
                                            aria-label={`${t(tree.stale ? "worktrees.forget" : "worktrees.remove")} ${label}`}
                                            title={
                                                tree.locked
                                                    ? tree.lockReason
                                                    : t(
                                                          tree.stale
                                                              ? "worktrees.forget"
                                                              : "worktrees.remove",
                                                      )
                                            }
                                            tone="danger"
                                            disabled={
                                                tree.locked ||
                                                (!tree.stale && !worktreeAvailable(tree))
                                            }
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
                title={t(removing?.stale ? "worktrees.forget" : "worktrees.removeTitle")}
                message={t(
                    removing?.stale ? "worktrees.forgetDescription" : "worktrees.removeDescription",
                    { path: removing?.path ?? "" },
                )}
                confirmLabel={
                    removeBusy
                        ? t("worktrees.removing")
                        : t(removing?.stale ? "worktrees.forget" : "worktrees.removeConfirm")
                }
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
