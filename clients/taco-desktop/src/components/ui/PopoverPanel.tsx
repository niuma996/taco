/**
 * PopoverPanel — the anchored panel the topbar's menus hang off: a title row
 * (with an optional trailing action) over a scrolling body.
 *
 * Owns the Radix Popover wiring *and* the surface chrome, so every topbar
 * panel lands on the same anchor, the same elevation and the same header
 * layout. Callers supply the trigger and the rows; the panel supplies the
 * frame.
 *
 * Pass `open`/`onOpenChange` to drive the panel from the outside — the
 * notification bell needs that, because "read" is tied to whether the panel
 * has been on screen. Leave them off for an uncontrolled panel.
 */
import * as Popover from "@radix-ui/react-popover";
import type { ReactElement, ReactNode } from "react";

export interface PopoverPanelProps {
    /** The control that opens the panel. */
    trigger: ReactElement;
    /** Title shown in the header row. */
    title: ReactNode;
    /** Trailing header control (e.g. "clear all"). */
    action?: ReactNode;
    /** Panel rows. */
    children: ReactNode;
    /** Surface modifier classes (e.g. a width variant). */
    className?: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /**
     * Which side of the trigger the panel opens on. Triggers live in the
     * topbar, so the default is `bottom`; Radix still flips when the viewport
     * leaves no room below.
     */
    side?: "top" | "bottom";
    /** Which edge of the trigger the panel aligns to. */
    align?: "start" | "center" | "end";
    /**
     * Stop Radix from closing the panel when focus leaves it. Use only when
     * a row inside the panel removes itself from the DOM (e.g. resolving an
     * approval), because focus falling back to the body would otherwise look
     * like the user left the panel. Escape and outside clicks still close.
     */
    keepOpenOnFocusLoss?: boolean;
}

export function PopoverPanel({
    trigger,
    title,
    action,
    children,
    className,
    open,
    onOpenChange,
    side = "bottom",
    align = "end",
    keepOpenOnFocusLoss = false,
}: PopoverPanelProps) {
    return (
        <Popover.Root open={open} onOpenChange={onOpenChange}>
            <Popover.Trigger asChild>{trigger}</Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    className={className ? `ui-popover-panel ${className}` : "ui-popover-panel"}
                    side={side}
                    sideOffset={6}
                    align={align}
                    collisionPadding={8}
                    aria-label={typeof title === "string" ? title : undefined}
                    // Rows carry their own controls, and resolving or dismissing
                    // one removes it from the DOM — focus then falls to the
                    // body, which Radix reads as focus leaving the panel and
                    // closes it, hiding whatever is still queued behind it.
                    // Escape and outside clicks still dismiss.
                    onFocusOutside={
                        keepOpenOnFocusLoss ? (event) => event.preventDefault() : undefined
                    }
                >
                    <div className="ui-popover-panel__header">
                        <span className="ui-popover-panel__title">{title}</span>
                        {action}
                    </div>
                    <div className="ui-popover-panel__body">{children}</div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
