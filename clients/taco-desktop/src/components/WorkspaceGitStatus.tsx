import { openUrl } from "@tauri-apps/plugin-opener";
import { GitBranch } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type GitWorkspaceClient, useGitWorkspace } from "../hooks/useGitWorkspace";
import { useT } from "../i18n/useI18n";
import { queryError } from "../lib/queries/queryClient";
import { Button } from "./ui/Button";

export interface WorkspaceGitStatusProps {
    client: GitWorkspaceClient;
    cwd: string;
    notify?: (message: string) => void;
    worktreePicker?: ReactNode;
}

export function WorkspaceGitStatus({
    client,
    cwd,
    notify,
    worktreePicker,
}: WorkspaceGitStatusProps) {
    const { t } = useT();
    const git = useGitWorkspace(client, cwd);
    const [actionError, setActionError] = useState<string | null>(null);
    const error = actionError ?? (git.error ? t("git.inspectFailed", { error: git.error }) : null);
    const result = git.data;
    const repository = result?.status === "repository" ? result.repository : null;
    const branch = repository?.branch;
    const label = repository
        ? repository.isBare
            ? t("git.bare")
            : (branch ??
              (repository.headOid
                  ? `${t("git.detached")} · ${repository.headOid.slice(0, 7)}`
                  : t("git.noCommits")))
        : result?.status === "missing"
          ? t("git.missing")
          : result?.status === "not_repository"
            ? t("git.notRepository")
            : git.loading
              ? t("git.loading")
              : null;

    async function runAction(action: () => Promise<unknown>, headline: string) {
        setActionError(null);
        try {
            await action();
        } catch (cause) {
            const message = `${headline}: ${queryError(cause)?.message ?? String(cause)}`;
            setActionError(message);
            notify?.(message);
        }
    }

    return (
        <div
            className="workspace-git-status"
            aria-label={t("git.status")}
            aria-busy={git.loading || git.initializing}
        >
            <div className="workspace-git-status__summary">
                {worktreePicker}
                <GitBranch size={14} aria-hidden="true" />
                <span className="workspace-git-status__label" title={branch ?? label ?? undefined}>
                    {label}
                </span>
            </div>
            <div className="workspace-git-status__actions">
                {result?.status === "not_repository" && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={git.initializing}
                        onClick={() => void runAction(git.init, t("git.initFailed"))}
                    >
                        {git.initializing ? t("git.creating") : t("git.create")}
                    </Button>
                )}
                {result?.status === "missing" && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                            void runAction(
                                () => openUrl("https://git-scm.com/downloads"),
                                t("git.installFailed"),
                            )
                        }
                    >
                        {t("git.install")}
                    </Button>
                )}
                {(error || result?.status === "missing") && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={git.refreshing}
                        onClick={() => {
                            setActionError(null);
                            void git.refresh();
                        }}
                    >
                        {t("git.retry")}
                    </Button>
                )}
            </div>
            {error && (
                <span className="workspace-git-status__error" role="alert">
                    {error}
                </span>
            )}
        </div>
    );
}
