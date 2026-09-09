import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared chrome for the right-side inline panels (task list, file tree):
 * a header row with the panel title, optional right-aligned action buttons,
 * and a circular X close button.
 * Panel-specific layout (width, border, body scroll) stays on the
 * consumer's own className so each panel keeps its own sizing rules.
 */
export function RightPanel({
    title,
    actions,
    onClose,
    closeLabel,
    className,
    children,
}: {
    title: ReactNode;
    /** Extra buttons rendered between the title and the close button. */
    actions?: ReactNode;
    onClose: () => void;
    closeLabel: string;
    className: string;
    children: ReactNode;
}) {
    return (
        <div className={className}>
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
