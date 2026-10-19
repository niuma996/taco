/**
 * PolicyRuleLayers — allow/deny rules grouped by contributing layer.
 *
 * Inherited groups are read-only; only the current scope's group accepts
 * edits. This makes the append semantics visible: the user is adding to the
 * parent list, not replacing it.
 *
 * The composer for new rules is docked at the bottom of the card rather than
 * living inside the editable group, so two rule editors of different length
 * still end on the same line.
 */

import type { ImPolicyRuleGroup } from "@taco-ai/protocol";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export interface PolicyRuleLayersProps {
    title: string;
    hint: string;
    groups: ImPolicyRuleGroup[];
    /** Live draft for the editable group. */
    localRules: string[];
    sourceLabels: Record<"global" | "channel" | "chat", string>;
    emptyLabel: string;
    addLabel: string;
    removeLabel: string;
    inputPlaceholder: string;
    disabled: boolean;
    /** Returns a localized error message, or null after adding the rule. */
    onAdd: (raw: string) => string | null;
    onRemove: (rule: string) => void;
}

export function PolicyRuleLayers(props: PolicyRuleLayersProps): React.ReactElement {
    const {
        title,
        hint,
        groups,
        localRules,
        sourceLabels,
        emptyLabel,
        addLabel,
        removeLabel,
        inputPlaceholder,
        disabled,
        onAdd,
        onRemove,
    } = props;
    const [input, setInput] = useState("");
    const [error, setError] = useState<string | null>(null);

    function submit(): void {
        const message = onAdd(input);
        if (message !== null) {
            setError(message);
            return;
        }
        setError(null);
        setInput("");
    }

    return (
        <section className="im-policy-rules" aria-label={title}>
            <header className="im-policy-rules-header">
                <span className="im-policy-rules-title">{title}</span>
            </header>
            <p className="im-policy-rules-hint">{hint}</p>
            <div className="im-policy-rule-groups">
                {groups.map((group) => {
                    const rules = group.editable ? localRules : group.rules;
                    return (
                        <div className="im-policy-rule-group" key={`${title}-${group.source}`}>
                            <div className="im-policy-rule-group-title">
                                {sourceLabels[group.source]}
                            </div>
                            {rules.length === 0 ? (
                                <p className="im-policy-rule-empty">{emptyLabel}</p>
                            ) : (
                                <ul className="permission-rule-list">
                                    {rules.map((rule) => (
                                        <li key={`${group.source}-${rule}`}>
                                            <span className="permission-rule-text">
                                                <code>{rule}</code>
                                            </span>
                                            {group.editable && (
                                                <IconButton
                                                    tone="danger"
                                                    disabled={disabled}
                                                    onClick={() => onRemove(rule)}
                                                    aria-label={removeLabel}
                                                >
                                                    <X size={12} aria-hidden="true" />
                                                </IconButton>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
            </div>
            {error !== null && (
                <div className="error-banner" role="alert">
                    {error}
                </div>
            )}
            {/* Docked at the bottom of the card: the two rule editors then end
                on the same line however many rules each one holds. */}
            <div className="im-policy-rule-add">
                <TextInput
                    type="text"
                    value={input}
                    disabled={disabled}
                    placeholder={inputPlaceholder}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") submit();
                    }}
                />
                <Button
                    size="sm"
                    variant="default"
                    disabled={disabled || input.trim().length === 0}
                    onClick={submit}
                >
                    {addLabel}
                </Button>
            </div>
        </section>
    );
}
