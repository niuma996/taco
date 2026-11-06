/**
 * ConfirmModal — shared confirm dialog. Close convention: every close path
 * (backdrop click / Escape / programmatic cancel) routes through `onCancel`,
 * preserving the "cancel = any close path" semantics — so callers (App.tsx)
 * don't need to change their props.
 */
import { useRef } from "react";
import { Button } from "./ui/Button.tsx";
import { Modal } from "./ui/Modal.tsx";

export interface ConfirmModalProps {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    error?: string | null;
    busy?: boolean;
    /** "danger" marks the action destructive: the confirm button takes the
     *  danger style and the open-time default focus moves to Cancel, so a
     *  reflexive Enter can never instantly confirm. */
    tone?: "default" | "danger";
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmModal(props: ConfirmModalProps) {
    const { open, title, message, confirmLabel, cancelLabel, error, busy, onConfirm, onCancel } =
        props;
    const tone = props.tone ?? "default";
    const confirmRef = useRef<HTMLButtonElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);

    return (
        <Modal
            open={open}
            onClose={onCancel}
            dismissible={!busy}
            title={title}
            description={message}
            // Default focus on open: confirm for routine actions, cancel for
            // destructive ones. We use onOpenAutoFocus rather than JSX
            // autoFocus — the latter is rejected by biome's noAutoFocus rule.
            onOpenAutoFocus={(e) => {
                e.preventDefault();
                (tone === "danger" ? cancelRef : confirmRef).current?.focus();
            }}
            actions={
                <>
                    <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
                        {cancelLabel ?? "Cancel"}
                    </Button>
                    <Button
                        ref={confirmRef}
                        variant={tone === "danger" ? "danger" : "primary"}
                        onClick={onConfirm}
                        disabled={busy}
                    >
                        {confirmLabel ?? "Confirm"}
                    </Button>
                </>
            }
        >
            {error ? (
                <div className="error-banner" role="alert">
                    {error}
                </div>
            ) : null}
        </Modal>
    );
}
