/**
 * Modal — shared Radix Dialog shell: portal, scrim, centered content, title,
 * and a right-aligned actions row. Replaces the Root/Portal/Overlay/Content
 * boilerplate every dialog used to copy by hand.
 *
 * Every dismiss path (Escape, scrim click, Cancel button) routes through
 * `onClose` so callers keep a single callback. Pass `dismissible={false}`
 * to ignore Escape/scrim while busy (e.g. an in-flight download) — the
 * caller keeps control of `open`, so the dialog simply stays mounted.
 *
 * Pass `description` only when the dialog has a real summary line: Radix
 * auto-links it via aria-describedby, and omitting Description entirely is
 * the documented alternative for dialogs whose title suffices.
 *
 * Layout contract: the title, description and `actions` row are pinned —
 * the modal is a flex column capped below the viewport, and `children` sit
 * in a `.ui-modal-body` region that scrolls. A dialog that renders its own
 * `.ui-modal-actions` inside children (e.g. to keep a submit button inside
 * its <form>) opts out of the pinned footer.
 *
 * Pass `bare` for a surface that draws its own header and scroll region
 * (the file preview window, the first-launch wizard): the title is rendered
 * with `.sr-only` so the dialog keeps an accessible name, and `children`
 * land directly on the surface instead of in a scrolling body.
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
