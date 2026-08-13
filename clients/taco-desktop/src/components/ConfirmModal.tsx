/**
 * ConfirmModal — Radix Dialog wrapper for focus trap, scroll lock, Escape to
 * close, and focus restoration. The visual layer is still driven by our own
 * `.modal-*` class names (behavior and styling stay decoupled).
 *
 * Close convention: every `onOpenChange(false)` (backdrop click / Escape /
 * programmatic cancel) routes through `onCancel`, preserving the "cancel =
 * any close path" semantics — so callers (App.tsx) don't need to change
 * their props.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useRef } from "react";
import { Button } from "./ui/Button.tsx";

export interface ConfirmModalProps {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmModal(props: ConfirmModalProps) {
    const { open, title, message, confirmLabel, cancelLabel, onConfirm, onCancel } = props;
    const confirmRef = useRef<HTMLButtonElement>(null);

    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!next) onCancel();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="modal-backdrop" />
                <Dialog.Content
                    className="modal"
                    // Keep the prior default-focus-on-confirm convention. We use onOpenAutoFocus
                    // rather than JSX autoFocus — the latter is rejected by biome's
                    // noAutoFocus rule.
                    onOpenAutoFocus={(e) => {
                        e.preventDefault();
                        confirmRef.current?.focus();
                    }}
                >
                    <Dialog.Title className="modal-title">{title}</Dialog.Title>
                    <Dialog.Description className="modal-message">{message}</Dialog.Description>
                    <div className="modal-actions">
                        <Button variant="ghost" onClick={onCancel}>
                            {cancelLabel ?? "Cancel"}
                        </Button>
                        <Button ref={confirmRef} variant="primary" onClick={onConfirm}>
                            {confirmLabel ?? "Confirm"}
                        </Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
