import type { CommandPermissionMode } from "@taco-ai/protocol";
import { useState } from "react";
import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { ClientRuleValidationError } from "../../lib/commandPermissionRuleClient.ts";
import { validatePermissionRuleClient } from "../../lib/commandPermissionRuleClient.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { Select } from "../ui/Select.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export interface PermissionsTabProps {
    client: TacoClient;
}

export function PermissionsTab({ client }: PermissionsTabProps) {
    const { global } = useGlobalConfig();
    const { save, saving, error } = useSaveConfigPatch(client);
    const { t } = useT();
    const config = global.commandPermissions ?? { mode: "ask" as const, rules: [] };

    const safeMode: "ask" | "auto" = config.mode === "auto" ? "auto" : "ask";

    const [newRule, setNewRule] = useState("");
    const [ruleError, setRuleError] = useState<ClientRuleValidationError | null>(null);

    function addRule() {
        const result = validatePermissionRuleClient(newRule);
        if (!result.valid) {
            setRuleError(result.reason);
            return;
        }
        setRuleError(null);
        void save({
            kind: "global",
            patch: {
                commandPermissions: {
                    ...config,
                    rules: Array.from(new Set([...config.rules, result.canonical])),
                },
            },
        });
        setNewRule("");
    }

    function removeRule(index: number) {
        const next = [...config.rules];
        next.splice(index, 1);
        void save({
            kind: "global",
            patch: {
                commandPermissions: { ...config, rules: next },
            },
        });
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
                                    ...config,
                                    mode: v as CommandPermissionMode,
                                },
                            },
                        })
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
            {config.rules.length === 0 ? (
                <p className="settings-tab-desc">{t("settings.permissionsNoRules")}</p>
            ) : (
                <ul className="permission-rule-list">
                    {config.rules.map((rule: string, i: number) => (
                        <li key={rule}>
                            <span className="permission-rule-text">
                                <code>{rule}</code>
                            </span>
                            <button
                                type="button"
                                className="permission-rule-remove"
                                disabled={saving}
                                title={t("settings.permissionsRemoveRule")}
                                onClick={() => removeRule(i)}
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {saving && <span className="settings-saving">{t("drawer.savingInline")}</span>}
            {error && <div className="error-banner">{error}</div>}
        </section>
    );
}
