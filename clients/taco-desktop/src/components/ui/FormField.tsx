/**
 * FormField — vertical label + control row, the common modal field layout.
 * Native labels focus single controls; compound groups use aria-labelledby.
 */
import {
    type AriaAttributes,
    type AriaRole,
    cloneElement,
    type ReactElement,
    type ReactNode,
    useId,
} from "react";

export interface FormFieldProps {
    /** Label text (or node). */
    label: ReactNode;
    children: ReactElement<AriaAttributes & { id?: string; role?: AriaRole }>;
    /** Label a compound group, preserving an existing role on its container. */
    group?: boolean;
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
    const { label, children, group = false, className, hint, error, action } = props;
    const generatedId = useId();
    const id = children.props.id ?? generatedId;
    const hintId = hint !== undefined ? `${id}-hint` : undefined;
    const errorId = error !== undefined ? `${id}-error` : undefined;
    const labelId = `${id}-label`;
    const describedBy =
        [children.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") ||
        undefined;
    const control = cloneElement(children, {
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error !== undefined ? true : children.props["aria-invalid"],
        ...(group
            ? {
                  role: children.props.role ?? "group",
                  "aria-labelledby": [children.props["aria-labelledby"], labelId]
                      .filter(Boolean)
                      .join(" "),
              }
            : {}),
    });
    const fieldLabel = group ? (
        <span id={labelId} className="ui-form-group-label">
            {label}
        </span>
    ) : (
        <label htmlFor={id}>{label}</label>
    );
    return (
        <div className={className ? `ui-form-field ${className}` : "ui-form-field"}>
            {action === undefined ? (
                fieldLabel
            ) : (
                <span className="ui-form-label-row">
                    {fieldLabel}
                    {action}
                </span>
            )}
            {control}
            {error !== undefined && (
                <span id={errorId} className="ui-form-error" role="status">
                    {error}
                </span>
            )}
            {hint !== undefined && (
                <span id={hintId} className="ui-form-hint">
                    {hint}
                </span>
            )}
        </div>
    );
}
