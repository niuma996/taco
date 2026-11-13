/**
 * Setup state for the optional Codex runtime.
 *
 * Shown in the create/edit dialog and on the Agents page, because a chat
 * spawn can fail before the user thinks to open the form. Installation and
 * sign-in stay separate. A missing npm does not get an Install button that
 * cannot succeed; the exact terminal command is shown instead.
 */
import type { AgentsRuntimeStatusResult } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";

export interface CodexRuntimeNoticeProps {
    status?: AgentsRuntimeStatusResult | null;
    loading?: boolean;
    installing?: boolean;
    error?: string | null;
    onInstall?: () => void;
    onRefresh?: () => void;
}

/** One-line command, horizontally scrollable, with a copy button beside it. */
function CommandBlock({ command }: { command: string }) {
    const { t } = useT();
    const [copied, setCopied] = useState(false);
    return (
        <div className="agent-form-command">
            <code>{command}</code>
            <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                    void navigator.clipboard
                        ?.writeText(command)
                        .then(() => {
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1500);
                        })
                        .catch(() => setCopied(false));
                }}
            >
                {copied ? t("agents.form.codexCopied") : t("agents.form.codexCopyCommand")}
            </Button>
        </div>
    );
}

type SetupTone = "ok" | "warn" | "pending";

/**
 * Seconds since the install started. The install downloads a platform
 * binary and can take a minute; without a clock the button just looks
 * frozen.
 */
function useElapsed(active: boolean): number {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        if (!active) return;
        setSeconds(0);
        const started = Date.now();
        const timer = window.setInterval(
            () => setSeconds(Math.floor((Date.now() - started) / 1000)),
            1000,
        );
        return () => window.clearInterval(timer);
    }, [active]);
    return seconds;
}

/** Install, sign-in, or ready state. Never treats an unknown check as "not installed". */
export function CodexRuntimeNotice(props: CodexRuntimeNoticeProps) {
    const { t } = useT();
    const status = props.status;
    const checking = props.loading || (status == null && !props.error);
    const installerMissing = status?.installer === "missing";

    const elapsed = useElapsed(props.installing === true);
    let tone: SetupTone = "pending";
    let chip = t("agents.form.codexChecking");
    let body = "";
    let detail = "";
    let command: string | undefined;

    if (props.installing) {
        tone = "pending";
        chip = t("agents.form.codexChipInstalling");
        body = t("agents.form.codexInstalling");
        detail = t("agents.form.codexInstallProgressHint");
    } else if (!checking && status != null) {
        if (status.installed) {
            if (status.auth === "signed-out") {
                tone = "warn";
                chip = t("agents.form.codexChipSignedOut");
                body = t("agents.form.codexSignedOut");
                command = status.loginCommand;
            } else if (status.auth === "unknown") {
                tone = "warn";
                chip = t("agents.form.codexChipUnknown");
                body = t("agents.form.codexAuthUnknown");
            } else {
                tone = "ok";
                chip = t("agents.form.codexChipReady");
                body = t("agents.form.codexInstalled", { version: status.version ?? "" });
                detail = status.model
                    ? t("agents.form.codexUsesConfig", {
                          model: status.model,
                          provider: status.provider ?? "",
                      })
                    : t("agents.form.codexUsesConfigDefault");
            }
        } else {
            tone = "warn";
            chip = t("agents.form.codexChipMissing");
            body = t("agents.form.codexNotInstalled");
            detail = installerMissing
                ? t("agents.form.codexNpmMissing")
                : t("agents.form.codexInstallHint");
            command = status.installCommand;
        }
    }

    return (
        <div className="codex-runtime-notice">
            {checking ? (
                <div className="codex-setup-card" role="status">
                    <div className="codex-setup-head">
                        <span className="codex-setup-title">
                            {t("agents.form.codexSetupTitle")}
                        </span>
                        <span className="codex-setup-chip codex-setup-chip--pending">{chip}</span>
                    </div>
                </div>
            ) : props.installing ? (
                <div className="codex-setup-card" role="status">
                    <div className="codex-setup-head">
                        <span className="codex-setup-title">
                            {t("agents.form.codexSetupTitle")}
                        </span>
                        <span className="codex-setup-chip codex-setup-chip--pending">{chip}</span>
                    </div>
                    <p className="codex-setup-text">{body}</p>
                    <p className="codex-setup-text">{detail}</p>
                    <p className="codex-setup-elapsed" aria-live="polite">
                        {elapsed}s
                    </p>
                </div>
            ) : status == null ? null : (
                <div className={`codex-setup-card codex-setup-card--${tone}`} role="status">
                    <div className="codex-setup-head">
                        <span className="codex-setup-title">
                            {t("agents.form.codexSetupTitle")}
                        </span>
                        <span className={`codex-setup-chip codex-setup-chip--${tone}`}>{chip}</span>
                    </div>
                    <p className="codex-setup-text">{body}</p>
                    {detail ? <p className="codex-setup-text">{detail}</p> : null}
                    {command ? <CommandBlock command={command} /> : null}
                    {!status.installed && !installerMissing ? (
                        <div className="codex-setup-actions">
                            <Button
                                size="sm"
                                variant="primary"
                                disabled={props.installing}
                                onClick={props.onInstall}
                            >
                                {t("agents.form.codexInstall")}
                            </Button>
                        </div>
                    ) : null}
                </div>
            )}
            {props.error ? (
                <div className="error-banner" role="alert">
                    {props.error}
                </div>
            ) : null}
            {status?.installed && status.auth !== "signed-in" && props.onRefresh ? (
                <div className="codex-setup-actions">
                    <Button size="sm" variant="ghost" onClick={props.onRefresh}>
                        {t("agents.form.codexRefreshStatus")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
