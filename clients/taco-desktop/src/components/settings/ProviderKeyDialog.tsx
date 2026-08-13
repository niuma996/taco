/**
 * ProviderKeyDialog — set/replace a provider's API key in a modal, shared by
 * built-in and custom provider rows. Submitting calls onSave with the trimmed
 * key; the caller performs the settings.write + refresh.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export interface ProviderKeyDialogProps {
    /** Provider display name — shown in the dialog title. */
    providerName: string;
    /** Whether the provider already has a key (title wording follows). */
    configured: boolean;
    /** Masked current key from the sidecar view (e.g. `sk-ant-…AbCd`); shown read-only when configured. */
    currentMask?: string;
    onSave: (key: string) => Promise<void>;
    onCancel: () => void;
}

export function ProviderKeyDialog(props: ProviderKeyDialogProps) {
    const { t } = useT();
    const [key, setKey] = useState("");
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        const trimmed = key.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
            await props.onSave(trimmed);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog.Root
            open
            onOpenChange={(next) => {
                if (!next) props.onCancel();
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="modal-backdrop" />
                <Dialog.Content className="modal provider-key-modal">
                    <Dialog.Title className="modal-title">
                        {props.configured
                            ? t("settings.providerReplaceKey")
                            : t("settings.providerSetKey")}
                    </Dialog.Title>
                    {props.configured && props.currentMask && (
                        <FormField label={t("settings.providerCurrentKey")}>
                            <TextInput
                                type="text"
                                className="provider-key-mask"
                                value={props.currentMask}
                                readOnly
                                aria-readonly="true"
                            />
                        </FormField>
                    )}
                    <FormField label={props.providerName}>
                        {/* Radix Dialog auto-focuses the first focusable element (this input). */}
                        <TextInput
                            type="password"
                            value={key}
                            placeholder={t("settings.providerKeyPlaceholder")}
                            autoComplete="off"
                            disabled={saving}
                            onChange={(e) => setKey(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void submit();
                            }}
                        />
                    </FormField>
                    <div className="modal-actions">
                        <Button variant="ghost" onClick={props.onCancel}>
                            {t("settings.providerCancel")}
                        </Button>
                        <Button
                            variant="primary"
                            disabled={saving || !key.trim()}
                            onClick={() => void submit()}
                        >
                            {t("settings.providerSaveKey")}
                        </Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
