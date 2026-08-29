/**
 * ImPolicyRuleListField — allow/deny rule editor with a tri-state
 * "override this list" Switch.
 *
 * Lives next to ImPolicyDialog because its gating semantics — when the
 * switch is off the field is omitted from the patch and inherited; when
 * on, the local list replaces the inherited one — are specific to the
 * IM policy patch shape. PermissionsTab has a similar visual but no
 * gating Switch and uses the same CSS classes (.permission-rule-list /
 * .permission-rule-remove), so a future extraction could unify both.
 */

import { useT } from "../i18n/useI18n.ts";
import type { ClientRuleValidationError } from "../lib/commandPermissionRuleClient.ts";
import { Switch } from "./ui/Switch.tsx";
import { TextInput } from "./ui/TextInput.tsx";

export interface ImPolicyRuleListFieldProps {
    title: string;
    enabled: boolean;
    onEnabledChange: (next: boolean) => void;
    rules: string[];
    input: string;
    onInputChange: (next: string) => void;
    onAdd: () => void;
    onRemove: (rule: string) => void;
    error: ClientRuleValidationError | null;
    disabled: boolean;
    addLabel: string;
    removeLabel: string;
    inputPlaceholder: string;
    emptyLabel: string;
}

export function ImPolicyRuleListField(props: ImPolicyRuleListFieldProps): React.ReactElement {
    const { t } = useT();
    const {
        title,
        enabled,
        onEnabledChange,
        rules,
        input,
        onInputChange,
        onAdd,
        onRemove,
        error,
        disabled,
        addLabel,
        removeLabel,
        inputPlaceholder,
        emptyLabel,
    } = props;
    return (
        <div className="im-policy-rules">
            <div className="im-policy-rules-header">
                <span className="ui-form-label">{title}</span>
                <Switch label={title} onChange={onEnabledChange} checked={enabled} />
            </div>
            {enabled && (
                <>
                    <div className="settings-row">
                        <TextInput
                            type="text"
                            value={input}
                            disabled={disabled}
                            placeholder={inputPlaceholder}
                            onChange={(e) => onInputChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") onAdd();
                            }}
                        />
                        <button
                            type="button"
                            className="settings-btn"
                            disabled={disabled || input.trim().length === 0}
                            onClick={onAdd}
                        >
                            {addLabel}
                        </button>
                    </div>
                    {error && (
                        <div className="error-banner">
                            {error.kind === "empty"
                                ? t("imPolicy.ruleErrorEmpty")
                                : t("imPolicy.ruleErrorShellWrapper", { shell: error.shell })}
                        </div>
                    )}
                    {rules.length === 0 ? (
                        <p className="settings-tab-desc">{emptyLabel}</p>
                    ) : (
                        <ul className="permission-rule-list">
                            {rules.map((rule) => (
                                <li key={rule}>
                                    <span className="permission-rule-text">
                                        <code>{rule}</code>
                                    </span>
                                    <button
                                        type="button"
                                        className="permission-rule-remove"
                                        disabled={disabled}
                                        onClick={() => onRemove(rule)}
                                        aria-label={removeLabel}
                                    >
                                        ×
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}
