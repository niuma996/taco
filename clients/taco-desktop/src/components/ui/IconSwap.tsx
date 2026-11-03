/**
 * IconSwap — cross-fades between icons instead of swapping one for the other.
 *
 * Rendering a different icon in place unmounts one SVG and mounts another,
 * which reads as a flicker. Every icon stays in the DOM, stacked in the same
 * grid cell, and the outgoing one fades out as the incoming one fades in.
 *
 * The icons must have the same size — the box takes the larger of them, and
 * a mismatch would leave the outgoing icon clipped.
 */
import type { ReactNode } from "react";

export interface IconSwapProps {
    /** The icons to stack, in the order they should be shown. */
    icons: ReactNode[];
    /** Index of the visible icon. */
    active: number;
    className?: string;
}

export function IconSwap({ icons, active, className }: IconSwapProps) {
    return (
        <span className={className ? `ui-icon-swap ${className}` : "ui-icon-swap"}>
            {icons.map((icon, i) => (
                <span key={i} data-icon-hidden={i === active ? "false" : "true"}>
                    {icon}
                </span>
            ))}
        </span>
    );
}
