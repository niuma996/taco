/**
 * RenameModal — session rename dialog with a controlled input. Submits after
 * trimming; newlines are folded to spaces before submit. Close routes through
 * onCancel.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/Button.tsx";
import { Modal } from "./ui/Modal.tsx";
import { TextInput } from "./ui/TextInput.tsx";

export interface RenameModalProps {
    open: boolean;
    initialName: string;
    title: string;
    placeholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onSubmit: (name: string) => void;
    onCancel: () => void;
}

export function RenameModal(props: RenameModalProps) {
    const { open, initialName, title, placeholder, confirmLabel, cancelLabel, onSubmit, onCancel } =
        props;
    const inputRef = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState(initialName);

    // Reset the input value on every open (and on initialName change).
    useEffect(() => {
        if (open) setValue(initialName);
    }, [open, initialName]);

    const normalized = value.replace(/[\r\n]+/g, " ").trim();
    const canSubmit = normalized.length > 0;

    const submit = () => {
        if (!canSubmit) return;
        onSubmit(normalized);
    };

    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={title}
            // Focus the input and select the existing name on open so users can
            // overwrite in one keystroke. Use onOpenAutoFocus instead of
            // JSX autoFocus (the latter is rejected by biome's noAutoFocus rule).
            onOpenAutoFocus={(e) => {
                e.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
            }}
        >
            <form
                className="rename-modal-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                }}
            >
                <TextInput
                    ref={inputRef}
                    type="text"
                    value={value}
                    placeholder={placeholder}
                    onChange={(e) => setValue(e.target.value)}
                />
                {/* Actions stay inside the form so Enter submits; the Modal
                    actions slot would render them outside it. */}
                <div className="ui-modal-actions">
                    <Button variant="ghost" onClick={onCancel}>
                        {cancelLabel ?? "Cancel"}
                    </Button>
                    <Button type="submit" variant="primary" disabled={!canSubmit}>
                        {confirmLabel ?? "Save"}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
