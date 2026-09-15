import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { DragHandleProps } from "../../hooks/primitives/useDragResize";

/**
 * Shared chrome for the right-side inline panels (task list, file tree,
 * subagents): a drag handle on the left edge, a header row with the panel
 * title, optional right-aligned action buttons, and a circular X close button.
 * Width is shared across all three panels via --right-panel-width, since they
 * occupy the same slot; per-panel layout (border, body scroll) stays on the
 * consumer's own className.
 */
export function RightPanel({
    title,
    actions,
    onClose,
    closeLabel,
    className,
    resizeHandleProps,
    resizeLabel,
    children,
}: {
    title: ReactNode;
    /** Extra buttons rendered between the title and the close button. */
    actions?: ReactNode;
    onClose: () => void;
    closeLabel: string;
    className: string;
    /** Omit to render a fixed-width panel (no drag handle). */
    resizeHandleProps?: DragHandleProps;
    resizeLabel?: string;
    children: ReactNode;
}) {
    return (
        <div className={className}>
            {resizeHandleProps && (
                <div
                    className="right-panel-resize"
                    aria-label={resizeLabel}
                    {...resizeHandleProps}
                />
            )}
            <div className="right-panel-topbar">
                <h3 className="right-panel-title">{title}</h3>
                {actions}
                <button
                    type="button"
                    className="right-panel-close"
                    onClick={onClose}
                    aria-label={closeLabel}
                    title={closeLabel}
                >
                    <X size={14} aria-hidden="true" />
                </button>
            </div>
            {children}
        </div>
    );
}
