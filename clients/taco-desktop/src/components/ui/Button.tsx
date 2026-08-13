// Shared text button. variant picks color, size picks density.
import type { ComponentPropsWithRef } from "react";

export type ButtonVariant = "ghost" | "default" | "primary" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
    variant?: ButtonVariant;
    size?: ButtonSize;
}

const SIZE_CLASS: Record<ButtonSize, string> = {
    sm: "ui-btn--sm",
    md: "ui-btn--md",
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
    ghost: "ui-btn--ghost",
    default: "ui-btn--default",
    primary: "ui-btn--primary",
    danger: "ui-btn--danger",
};

export function Button({
    variant = "default",
    size = "md",
    className,
    type = "button",
    ...rest
}: ButtonProps) {
    const classes = ["ui-btn", SIZE_CLASS[size], VARIANT_CLASS[variant], className]
        .filter(Boolean)
        .join(" ");
    return <button type={type} className={classes} {...rest} />;
}
