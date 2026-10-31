// Hover/focus label for icon-only controls. Built on Radix HoverCard (already a
// dependency) so the label renders through a Portal and escapes ancestors with
// overflow: hidden. The trigger keeps its own aria-label — the label here is
// visual only and is not announced.
import * as HoverCard from "@radix-ui/react-hover-card";
import type { ReactElement } from "react";

export interface TooltipProps {
    label: string;
    /** Preferred side; Radix flips it when there is no room. */
    side?: "top" | "bottom" | "left" | "right";
    /** Single element that receives the hover/focus handlers. */
    children: ReactElement;
}

export function Tooltip({ label, side = "top", children }: TooltipProps) {
    return (
        <HoverCard.Root openDelay={250} closeDelay={0}>
            <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
            <HoverCard.Portal>
                <HoverCard.Content
                    className="ui-tooltip"
                    side={side}
                    sideOffset={6}
                    collisionPadding={8}
                >
                    {label}
                </HoverCard.Content>
            </HoverCard.Portal>
        </HoverCard.Root>
    );
}
