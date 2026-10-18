/**
 * PolicyValueCard — one policy field in the IM strategy editor.
 *
 * Shows the effective value and the layer that supplied it. The current
 * layer either follows the parent (only an override action is offered) or
 * overrides the parent (the edit control is revealed plus a reset action).
 * Keeping the state and the action separate avoids presenting "inherit" as
 * a value alongside the real values.
 */

import type { ReactNode } from "react";
import { Button } from "../ui/Button.tsx";

export interface PolicyValueCardProps {
    label: string;
    /** Human-readable effective value, already localized. */
    value: string;
    /** Localized source layer, e.g. "Global policy". */
    source: string;
    /** Localized state badge, e.g. "Following parent". */
    state: string;
    overridden: boolean;
    overrideLabel: string;
    resetLabel: string;
    onOverride: () => void;
    onReset: () => void;
    disabled?: boolean;
    hint?: ReactNode;
    children?: ReactNode;
}

export function PolicyValueCard(props: PolicyValueCardProps): React.ReactElement {
    const {
        label,
        value,
        source,
        state,
        overridden,
        overrideLabel,
        resetLabel,
        onOverride,
        onReset,
        disabled,
        hint,
        children,
    } = props;
    return (
        <fieldset
            className={overridden ? "im-policy-field is-override" : "im-policy-field"}
            aria-label={label}
        >
            <legend className="im-policy-field-head">
                <span className="im-policy-field-label">{label}</span>
                <span
                    className={
                        overridden ? "im-policy-field-badge is-override" : "im-policy-field-badge"
                    }
                >
                    {state}
                </span>
            </legend>
            <div className="im-policy-field-value">{value}</div>
            <div className="im-policy-field-source">{source}</div>
            {overridden && children !== undefined && (
                <div className="im-policy-field-control">{children}</div>
            )}
            {hint !== undefined && <div className="im-policy-field-hint">{hint}</div>}
            <div className="im-policy-field-actions">
                {overridden ? (
                    <Button size="sm" variant="ghost" disabled={disabled} onClick={onReset}>
                        {resetLabel}
                    </Button>
                ) : (
                    <Button size="sm" variant="default" disabled={disabled} onClick={onOverride}>
                        {overrideLabel}
                    </Button>
                )}
            </div>
        </fieldset>
    );
}
