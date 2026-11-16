import {
    type ExtensionConfigField,
    type ExtensionConfigResult,
    extensionConfigFields,
} from "@taco-ai/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { useT } from "../i18n/useI18n";
import type { TacoClient } from "../lib/clients/tacoClient";
import { PluginConfigFields } from "./PluginConfigFields";
import { initialPluginDraft, pluginConfigPatch } from "./pluginConfigForm";

export type PluginDialogEntry = {
    name: string;
    configSchema?: Record<string, unknown>;
    description?: string;
};
export interface PluginSettingsAccess {
    client: TacoClient;
    onSaved: () => Promise<void>;
}

export function PluginSettingsDialog({
    entry,
    client,
    onSaved,
    onClose,
    children,
}: Partial<PluginSettingsAccess> & {
    entry: PluginDialogEntry;
    onClose: () => void;
    children?: ReactNode;
}) {
    const { t, i18n } = useT();
    const [config, setConfig] = useState<ExtensionConfigResult>();
    const [draft, setDraft] = useState<Record<string, string | boolean>>({});
    const [edited, setEdited] = useState(new Set<string>());
    const [reset, setReset] = useState(new Set<string>());
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [error, setError] = useState<string>();
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const closeRef = useRef<HTMLButtonElement>(null);
    const fields = extensionConfigFields(config?.schema);
    useEffect(() => {
        if (!entry.configSchema || !client) return;
        let current = true;
        client
            .extensionConfigGet({ name: entry.name })
            .then((result) => {
                if (!current) return;
                setConfig(result);
                setDraft(initialPluginDraft(extensionConfigFields(result.schema), result));
            })
            .catch((error: unknown) => {
                if (!current) return;
                console.error("[taco] extensionConfigGet failed", error);
                setError(t("plugins.configLoadFailed"));
            });
        return () => {
            current = false;
        };
    }, [client, entry.name, entry.configSchema, t]);
    const change = (key: string, value: string | boolean) => {
        setDraft((previous) => ({ ...previous, [key]: value }));
        setEdited((previous) => new Set(previous).add(key));
        setReset((previous) => {
            const next = new Set(previous);
            next.delete(key);
            return next;
        });
        setErrors((previous) => {
            const next = { ...previous };
            delete next[key];
            return next;
        });
        setSaved(false);
    };
    const resetField = (field: ExtensionConfigField) => {
        const initial = initialPluginDraft([field], {
            schema: {},
            values: {},
            configuredSecrets: [],
            pendingRestart: false,
        });
        change(field.key, initial[field.key] ?? "");
        setReset((previous) => new Set(previous).add(field.key));
    };
    const save = async () => {
        if (!client) return;
        const patch = pluginConfigPatch(fields, draft, edited, reset);
        setErrors(patch.errors);
        if (Object.keys(patch.errors).length) return;
        setSaving(true);
        setError(undefined);
        try {
            const result = await client.extensionConfigUpdate({
                name: entry.name,
                values: patch.values,
                unset: patch.unset,
            });
            setConfig(result);
            setDraft(initialPluginDraft(fields, result));
            setEdited(new Set());
            setReset(new Set());
            setSaved(true);
            await onSaved?.();
        } catch (error) {
            setError(error instanceof Error ? error.message : t("plugins.configSaveFailed"));
        } finally {
            setSaving(false);
        }
    };
    const propertyCount =
        config?.schema.properties && typeof config.schema.properties === "object"
            ? Object.keys(config.schema.properties).length
            : 0;
    return (
        <Modal
            open
            onClose={onClose}
            dismissible={!saving}
            title={entry.name}
            description={entry.description ?? t("plugins.detailsDescription")}
            className="plugins-settings-dialog"
            onOpenAutoFocus={(event) => {
                event.preventDefault();
                closeRef.current?.focus();
            }}
            actions={
                <>
                    <Button ref={closeRef} onClick={onClose} disabled={saving}>
                        {t("plugins.closeDetails")}
                    </Button>
                    {fields.some((field) => !field.readOnly) && (
                        <Button
                            variant="primary"
                            disabled={saving || edited.size === 0}
                            onClick={() => void save()}
                        >
                            {t(saving ? "plugins.savingConfig" : "plugins.saveConfig")}
                        </Button>
                    )}
                </>
            }
        >
            {entry.configSchema && client && (
                <section className="plugins-settings-section">
                    <h3>{t("plugins.configuration")}</h3>
                    <p className="plugins-registration-hint">{t("plugins.configRestartHint")}</p>
                    {!config && !error && <p role="status">{t("plugins.configLoading")}</p>}
                    {config && fields.length > 0 && (
                        <PluginConfigFields
                            fields={fields}
                            result={config}
                            draft={draft}
                            errors={errors}
                            disabled={saving}
                            onChange={change}
                            onReset={resetField}
                            t={t}
                            locale={i18n.language}
                        />
                    )}
                    {config && propertyCount === 0 && (
                        <p className="plugins-registration-hint">{t("plugins.configNoFields")}</p>
                    )}
                    {config && propertyCount > fields.length && (
                        <p className="plugins-registration-hint">
                            {t("plugins.configUnsupported")}
                        </p>
                    )}
                    {(saved || config?.pendingRestart) && (
                        <p
                            role="status"
                            className={
                                saved
                                    ? "plugins-config-feedback plugins-config-feedback--success"
                                    : "plugins-config-feedback plugins-config-feedback--pending"
                            }
                        >
                            {t(saved ? "plugins.configSaved" : "plugins.configPending")}
                        </p>
                    )}
                </section>
            )}
            {error && (
                <p role="alert" className="plugins-config-error">
                    {error}
                </p>
            )}
            {children && (
                <section className="plugins-settings-section">
                    <h3>{t("plugins.contributionDetails")}</h3>
                    {children}
                </section>
            )}
        </Modal>
    );
}
