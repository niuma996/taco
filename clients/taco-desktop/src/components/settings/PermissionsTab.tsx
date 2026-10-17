import type { CommandPermissionMode } from "@taco-ai/protocol";
import { X } from "lucide-react";
import { useState } from "react";
import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import type { ClientRuleValidationError } from "../../lib/commandPermissionRuleClient.ts";
import { validatePermissionRuleClient } from "../../lib/commandPermissionRuleClient.ts";
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

    const canonicalConfig = {
        mode: config.mode,
        allow,
        deny,
        ...(config.allowedDirectories ? { allowedDirectories: config.allowedDirectories } : {}),
    };

    const safeMode: "ask" | "auto" = config.mode === "auto" ? "auto" : "ask";

    const [newRule, setNewRule] = useState("");
    const [ruleError, setRuleError] = useState<ClientRuleValidationError | null>(null);
    const [list, setList] = useState<"allow" | "deny">("allow");

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
                commandPermissions: {
                    ...canonicalConfig,
                    [list]: Array.from(
                        new Set([...(list === "allow" ? allow : deny), result.canonical]),
                    ),
                },
            },
        })
            // Keep the input on failure so the rule is not lost; the hook shows the error.
            .then(() => setNewRule(""))
            .catch(() => {});
    }

    function removeRule(index: number) {
        const current = list === "allow" ? allow : deny;
        const next = [...current];
        next.splice(index, 1);
        void save({
            kind: "global",
            patch: {
                commandPermissions: { ...canonicalConfig, [list]: next },
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
                                commandPermissions: {
                                    ...canonicalConfig,
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
                    {(list === "allow" ? allow : deny).map((rule: string, i: number) => (
                        <li key={rule}>
                            <span className="permission-rule-text">
                                <code>{rule}</code>
                            </span>
                            <IconButton
                                tone="danger"
                                disabled={saving}
                                title={t("settings.permissionsRemoveRule")}
                                aria-label={t("settings.permissionsRemoveRule")}
                                onClick={() => removeRule(i)}
                            >
                                <X size={12} aria-hidden="true" />
                            </IconButton>
                        </li>
                    ))}
                </ul>
            )}
            {saving && <span className="settings-saving">{t("drawer.savingInline")}</span>}
            {error && <div className="error-banner">{error}</div>}
        </section>
    );
}
