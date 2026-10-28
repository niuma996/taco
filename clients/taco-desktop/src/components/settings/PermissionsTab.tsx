import { BUILTIN_READ_ONLY_COMMANDS, type CommandPermissionMode } from "@taco-ai/protocol";
import { X } from "lucide-react";
import { useState } from "react";
import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import type { ClientRuleValidationError } from "../../lib/commandPermissionRuleClient.ts";
import { validatePermissionRuleClient } from "../../lib/commandPermissionRuleClient.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export interface PermissionsTabProps {
    client: TacoClient;
}

export function PermissionsTab({ client }: PermissionsTabProps) {
    const { global } = useGlobalConfig();
    const { save, saving, error } = useSaveConfigPatch(client);
    const { t } = useT();
    const config = global.commandPermissions ?? { mode: "ask" as const, allow: [], deny: [] };
    const allow = config.allow ?? config.rules ?? [];
    const deny = config.deny ?? [];

    const safeMode: "ask" | "auto" = config.mode === "auto" ? "auto" : "ask";

    const [newRule, setNewRule] = useState("");
    const [ruleError, setRuleError] = useState<ClientRuleValidationError | null>(null);
    const [list, setList] = useState<"allow" | "deny">("allow");
    /** Rule text awaiting the shared confirm dialog — removal edits config. */
    const [pendingRemove, setPendingRemove] = useState<string | null>(null);

    function addRule() {
        const result = validatePermissionRuleClient(newRule, {
            allowShellWrapper: list === "deny",
        });
        if (!result.valid) {
            setRuleError(result.reason);
            return;
        }
        setRuleError(null);
        void save({
            kind: "global",
            patch: {
                commandPermissionsEdit: {
                    [list === "allow" ? "addAllow" : "addDeny"]: [result.canonical],
                },
            },
        })
            // Keep the input on failure so the rule is not lost; the hook shows the error.
            .then(() => setNewRule(""))
            .catch(() => {});
    }

    function removeRule(rule: string) {
        void save({
            kind: "global",
            patch: {
                commandPermissionsEdit: {
                    [list === "allow" ? "removeAllow" : "removeDeny"]: [rule],
                },
            },
        }).catch(() => {});
    }

    return (
        <section className="settings-tab">
            <h3>{t("settings.permissionsTitle")}</h3>
            <p className="settings-tab-desc">{t("settings.permissionsDesc")}</p>
            <div className="settings-row">
                <span className="permissions-mode-label">{t("settings.permissionsMode")}</span>
                <Select
                    value={safeMode}
                    disabled={saving}
                    onValueChange={(v) =>
                        void save({
                            kind: "global",
                            patch: {
                                commandPermissionsEdit: {
                                    mode: v as CommandPermissionMode,
                                },
                            },
                        }).catch(() => {})
                    }
                    options={[
                        { value: "ask", label: t("settings.permissionsAsk") },
                        { value: "auto", label: t("settings.permissionsAuto") },
                    ]}
                    label={t("settings.permissionsMode")}
                />
            </div>
            <p className="settings-tab-desc">{t("settings.permissionsRules")}</p>
            <details className="permission-builtin">
                <summary>{t("settings.permissionsBuiltinAllowList")}</summary>
                <p className="settings-tab-desc">{t("settings.permissionsBuiltinAllowListDesc")}</p>
                <ul className="permission-builtin-list">
                    {BUILTIN_READ_ONLY_COMMANDS.map((command) => (
                        <li key={command}>
                            <code>{command}</code>
                        </li>
                    ))}
                </ul>
            </details>
            <div className="settings-row">
                <Select
                    value={list}
                    disabled={saving}
                    onValueChange={(v) => setList(v as "allow" | "deny")}
                    options={[
                        { value: "allow", label: t("settings.permissionsAllowList") },
                        { value: "deny", label: t("settings.permissionsDenyList") },
                    ]}
                    label={t("settings.permissionsRuleType")}
                />
            </div>
            <div className="settings-row">
                <TextInput
                    type="text"
                    value={newRule}
                    disabled={saving}
                    placeholder={t("settings.permissionsRulePlaceholder")}
                    onChange={(e) => {
                        setNewRule(e.target.value);
                        if (ruleError) setRuleError(null);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") addRule();
                    }}
                />
                <button
                    type="button"
                    className="settings-btn"
                    disabled={saving || newRule.trim().length === 0}
                    onClick={addRule}
                >
                    {t("settings.permissionsAddRule")}
                </button>
            </div>
            {ruleError && (
                <div className="error-banner">
                    {ruleError.kind === "empty"
                        ? t("settings.permissionsRuleErrorEmpty")
                        : t("settings.permissionsRuleErrorShellWrapper", {
                              shell: ruleError.shell,
                          })}
                </div>
            )}
            {(list === "allow" ? allow : deny).length === 0 ? (
                <p className="settings-tab-desc">{t("settings.permissionsNoRules")}</p>
            ) : (
                <ul className="permission-rule-list">
                    {(list === "allow" ? allow : deny).map((rule: string) => (
                        <li key={rule}>
                            <span className="permission-rule-text">
                                <code>{rule}</code>
                            </span>
                            <IconButton
                                tone="danger"
                                disabled={saving}
                                title={t("settings.permissionsRemoveRule")}
                                aria-label={t("settings.permissionsRemoveRule")}
                                onClick={() => setPendingRemove(rule)}
                            >
                                <X size={12} aria-hidden="true" />
                            </IconButton>
                        </li>
                    ))}
                </ul>
            )}
            {saving && <span className="settings-saving">{t("drawer.savingInline")}</span>}
            {error && <div className="error-banner">{error}</div>}
            <ConfirmModal
                open={pendingRemove !== null}
                title={t("settings.permissionsRemoveConfirmTitle")}
                message={pendingRemove ?? ""}
                confirmLabel={t("settings.permissionsRemoveConfirm")}
                cancelLabel={t("settings.permissionsCancel")}
                onConfirm={() => {
                    const rule = pendingRemove;
                    setPendingRemove(null);
                    if (rule !== null) removeRule(rule);
                }}
                onCancel={() => setPendingRemove(null)}
            />
        </section>
    );
}
