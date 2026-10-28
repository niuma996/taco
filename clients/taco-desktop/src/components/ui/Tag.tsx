// Shared outlined tag: a small pill labelling a row or value (origin, transport, built-in).
import type { ComponentPropsWithRef } from "react";

// md is the standalone uppercase chip; sm is the sentence-case form that sits inline after text.
export type TagSize = "sm" | "md";
// strong draws the border at text strength, for states that must not read as passive metadata.
export type TagTone = "default" | "strong";

export interface TagProps extends ComponentPropsWithRef<"span"> {
    size?: TagSize;
    tone?: TagTone;
}

export function Tag({ size = "md", tone = "default", className, ...rest }: TagProps) {
    const classes = [
        "ui-tag",
        `ui-tag--${size}`,
        tone === "strong" ? "ui-tag--strong" : undefined,
        className,
    ]
        .filter(Boolean)
        .join(" ");
    return <span className={classes} {...rest} />;
}
