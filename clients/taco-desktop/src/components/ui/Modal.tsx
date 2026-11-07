/**
 * Modal — shared Radix Dialog shell: portal, scrim, centered content, title,
 * and a right-aligned actions row. Every dismiss path routes through
 * `onClose`; `dismissible={false}` ignores Escape/scrim while busy.
 * `description` is only for a real summary line — Radix links it via
 * aria-describedby.
 *
 * Layout contract: title, description and the `actions` row are pinned;
 * `children` sit in a scrolling `.ui-modal-body`. A dialog that renders its
 * own `.ui-modal-actions` inside children opts out of the pinned footer.
 * `bare` is for a surface that draws its own header — the title stays
 * (`.sr-only`) so the dialog keeps an accessible name.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { useRef } from "react";

export interface ModalProps {
    open: boolean;
    onClose: () => void;
    /** When false, Escape and scrim clicks are ignored (busy states). */
    dismissible?: boolean;
    title: ReactNode;
    /** Secondary line under the title, linked as the dialog's description. */
    description?: ReactNode;
    /** Appended to "ui-modal" — feature modifier classes (e.g. "mcp-server-modal"). */
    className?: string;
    /** Appended to "ui-modal-backdrop" — feature scrims (e.g. a blur). */
    backdropClassName?: string;
    /** Render children on the bare surface: no visible title, no scroll body. */
    bare?: boolean;
    /** Radix open-autofocus hook, for dialogs that focus a specific control. */
    onOpenAutoFocus?: (event: Event) => void;
    /** Right-aligned button row; omit when children render their own actions. */
    actions?: ReactNode;
    children?: ReactNode;
}

export function Modal(props: ModalProps) {
    const {
        open,
        onClose,
        dismissible = true,
        title,
        description,
        className,
        backdropClassName,
        bare = false,
        onOpenAutoFocus,
        actions,
        children,
    } = props;
    // Radix restores focus only to a Dialog.Trigger, and our modals are
    // controlled without one (close would otherwise dump focus on <body>).
    // Capture the pre-open element at open-autofocus time — before Radix
    // moves focus into the dialog — and restore it on close.
    const restoreFocusTo = useRef<Element | null>(null);
    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!next && dismissible) onClose();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay
                    className={
                        backdropClassName
                            ? `ui-modal-backdrop ${backdropClassName}`
                            : "ui-modal-backdrop"
                    }
                />
                <Dialog.Content
                    className={className ? `ui-modal ${className}` : "ui-modal"}
                    onOpenAutoFocus={(e) => {
                        restoreFocusTo.current = document.activeElement;
                        onOpenAutoFocus?.(e);
                    }}
                    onCloseAutoFocus={(e) => {
                        e.preventDefault();
                        (restoreFocusTo.current as HTMLElement | null)?.focus();
                    }}
                >
                    {/* `bare` dialogs draw their own header, but Radix still needs
                        a Title to label the dialog — hide it rather than drop it. */}
                    <Dialog.Title className={bare ? "sr-only" : "ui-modal-title"}>
                        {title}
                    </Dialog.Title>
                    {!bare && description !== undefined && (
                        <Dialog.Description className="ui-modal-message">
                            {description}
                        </Dialog.Description>
                    )}
                    {bare ? children : <div className="ui-modal-body">{children}</div>}
                    {actions !== undefined && <div className="ui-modal-actions">{actions}</div>}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
