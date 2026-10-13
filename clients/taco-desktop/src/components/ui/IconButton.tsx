// Shared icon-only button. size picks the box (sm 18 / md 22 / lg 26),
// variant adds a border, tone="danger" turns the hover red. Toggle buttons
// pass aria-pressed; the pressed state is styled from that attribute.
// Callers keep their own className for placement only (margins, absolute
// positioning, hover-reveal) — never for color, size or radius.
import type { ComponentPropsWithRef } from "react";

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "outline";
export type IconButtonTone = "default" | "danger";

export interface IconButtonProps extends ComponentPropsWithRef<"button"> {
    /** Accessible name — icon-only buttons have no text, so this is required. */
    "aria-label": string;
    size?: IconButtonSize;
    variant?: IconButtonVariant;
    tone?: IconButtonTone;
}

export function IconButton({
    size = "md",
    variant = "ghost",
    tone = "default",
    className,
    type = "button",
    ...rest
}: IconButtonProps) {
    const classes = [
        "ui-icon-btn",
        `ui-icon-btn--${size}`,
        variant === "outline" && "ui-icon-btn--outline",
        tone === "danger" && "ui-icon-btn--danger",
        className,
    ]
        .filter(Boolean)
        .join(" ");
    return <button type={type} className={classes} {...rest} />;
}
