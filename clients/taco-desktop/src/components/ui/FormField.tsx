/**
 * FormField — vertical label + control row, the common modal field layout.
 * Uses the native <label> + htmlFor association so the label text remains
 * click-targetable for focus. `children` is the single control.
 */
import type { ReactElement, ReactNode } from "react";

export interface FormFieldProps {
    /** Label text (or node). */
    label: ReactNode;
    children: ReactElement<{ id?: string }>;
    className?: string;
    /** Secondary text rendered under the control. */
    hint?: ReactNode;
    /** Error message rendered under the control (distinct error styling). */
    error?: ReactNode;
    /**
     * Control rendered on the label row, right-aligned (e.g. a "fetch" button).
     * Kept as a sibling of <label> rather than inside it: interactive elements
     * nested in a label lose their accessible name to the label's text content,
     * and clicking the label text would activate them.
     */
    action?: ReactNode;
}

export function FormField(props: FormFieldProps): ReactElement {
    const { label, children, className, hint, error, action } = props;
    const id = children.props.id as string | undefined;
    return (
        <div className={className ? `ui-form-field ${className}` : "ui-form-field"}>
            {action === undefined ? (
                <label htmlFor={id}>{label}</label>
            ) : (
                <span className="ui-form-label-row">
                    <label htmlFor={id}>{label}</label>
                    {action}
                </span>
            )}
            {children}
            {error !== undefined && <span className="ui-form-error">{error}</span>}
            {hint !== undefined && <span className="ui-form-hint">{hint}</span>}
        </div>
    );
}
