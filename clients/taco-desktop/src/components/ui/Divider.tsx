// Hairline separator. orientation picks the axis; tone picks the weight —
// "inline" for a tick between sibling controls, "section" for a block
// boundary. Size and placement stay with the caller's stylesheet.
export type DividerOrientation = "horizontal" | "vertical";
export type DividerTone = "inline" | "section";

export interface DividerProps {
    orientation?: DividerOrientation;
    tone?: DividerTone;
    className?: string;
}

export function Divider({ orientation = "horizontal", tone = "inline", className }: DividerProps) {
    const classes = ["ui-divider", `ui-divider--${tone}`, className].filter(Boolean).join(" ");
    return <div className={classes} data-orientation={orientation} aria-hidden="true" />;
}
