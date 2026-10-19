/**
 * PolicyValueCard — one policy field in the IM strategy editor.
 *
 * A label over a single control. The control lists every value and tags the
 * one the parent layer would supply; picking that one means "follow the
 * parent", so there is no separate override / restore state to show. The
 * card border turns accent while the current layer overrides the parent.
 *
 * The group is a legend-less fieldset named by `aria-label`: a legend would
 * break out of the card's border, and the label already lives in the head row.
 */

import type { ReactNode } from "react";

export interface PolicyValueCardProps {
    label: string;
    /** True when the current layer sets a value of its own. */
    overridden: boolean;
    /** Extra class on the card, e.g. to span it across the field grid. */
    className?: string;
    children: ReactNode;
}

export function PolicyValueCard(props: PolicyValueCardProps): React.ReactElement {
    const { label, overridden, className, children } = props;
    const classes = ["im-policy-field", overridden ? "is-override" : "", className ?? ""]
        .filter(Boolean)
        .join(" ");
    return (
        <fieldset className={classes} aria-label={label}>
            <span className="im-policy-field-label">{label}</span>
            <div className="im-policy-field-control">{children}</div>
        </fieldset>
    );
}
