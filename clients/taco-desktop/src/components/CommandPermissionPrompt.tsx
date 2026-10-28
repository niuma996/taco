/**
 * CommandPermissionPrompt — risk line, command, and the allow/deny button set
 * for one shell approval. Shared by the tool card and the workspace-level
 * pending-approvals modal so the two surfaces cannot drift.
 */

import type {
    CommandEvaluation,
    CommandPermissionScope,
    PermissionRequestKind,
} from "@taco-ai/protocol";
import type { ReactNode } from "react";
import { useState } from "react";
import { useT } from "../i18n/useI18n";

export interface CommandPermissionPromptRequest {
    requestId: string;
    command: string;
    /**
     * What is being approved. "command" (the default) is a shell command;
     * "config" is a global-config change, where there is no command to show
     * and the fields being changed take its place.
     */
    kind?: PermissionRequestKind;
    /** For kind="config": the config fields the change touches. */
    configFields?: readonly string[];
    evaluation: Pick<
        CommandEvaluation,
        | "risk"
        | "reason"
        | "matchedList"
        | "matchedRule"
        | "triggeringCommand"
        | "persistentAllowed"
    >;
}

export function CommandPermissionPrompt({
    request,
    onResolve,
    className,
    children,
}: {
    request: CommandPermissionPromptRequest;
    onResolve: (
        requestId: string,
        approved: boolean,
        scope: CommandPermissionScope,
    ) => Promise<void> | void;
    /** Appended to "permission-prompt" — surface-specific layout. */
    className?: string;
    /** Rendered between the command and the buttons (e.g. the origin session). */
    children?: ReactNode;
}) {
    const { t } = useT();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isConfig = request.kind === "config";

    // Blacklist matches and unsupported syntax only support one-time approval.
    const persistentDisabled =
        request.evaluation.matchedList === "deny" || request.evaluation.persistentAllowed === false;

    const handle = async (approved: boolean, scope: CommandPermissionScope) => {
        setSubmitting(true);
        setError(null);
        try {
            await onResolve(request.requestId, approved, scope);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSubmitting(false);
        }
    };

    const riskLabel = isConfig
        ? t("configChange.risk")
        : t(
              `settings.permissionsRisk${request.evaluation.risk.charAt(0).toUpperCase()}${request.evaluation.risk.slice(1)}`,
          );

    return (
        <div className={className ? `permission-prompt ${className}` : "permission-prompt"}>
            <div>
                {riskLabel}: {request.evaluation.reason}
            </div>
            {isConfig ? (
                <div className="permission-prompt-command">
                    {(request.configFields ?? []).map((field) => (
                        <div key={field} className="config-change-field">
                            {field}
                        </div>
                    ))}
                </div>
            ) : (
                <div className="permission-prompt-command">{request.command}</div>
            )}
            {children}
            <div className="permission-prompt-actions">
                <div className="permission-prompt-buttons">
                    <button
                        type="button"
                        className="permission-allow"
                        disabled={submitting}
                        onClick={() => void handle(true, "once")}
                    >
                        {submitting
                            ? t("settings.permissionsSubmitting")
                            : t("settings.permissionsAllowOnce")}
                    </button>
                    {/* A config change is global, so "allow for the session" and
                        "always allow" have no meaningful scope — the change is
                        already written, and there is nothing to remember. */}
                    {!isConfig && (
                        <>
                            <button
                                type="button"
                                className="permission-allow"
                                disabled={submitting || persistentDisabled}
                                title={
                                    persistentDisabled
                                        ? t("settings.permissionsPersistentDisabled")
                                        : undefined
                                }
                                onClick={() => void handle(true, "session")}
                            >
                                {submitting
                                    ? t("settings.permissionsSubmitting")
                                    : t("settings.permissionsAllowSession")}
                            </button>
                            <button
                                type="button"
                                className="permission-allow"
                                disabled={submitting || persistentDisabled}
                                title={
                                    persistentDisabled
                                        ? t("settings.permissionsPersistentDisabled")
                                        : t("settings.permissionsAlwaysAllowHint")
                                }
                                onClick={() => void handle(true, "global")}
                            >
                                {submitting
                                    ? t("settings.permissionsSubmitting")
                                    : t("settings.permissionsAlwaysAllow")}
                            </button>
                        </>
                    )}
                    <button
                        type="button"
                        className="permission-deny"
                        disabled={submitting}
                        onClick={() => void handle(false, "once")}
                    >
                        {t("settings.permissionsDeny")}
                    </button>
                </div>
                {error && (
                    <span className="permission-error" role="alert">
                        {error}
                    </span>
                )}
            </div>
        </div>
    );
}
