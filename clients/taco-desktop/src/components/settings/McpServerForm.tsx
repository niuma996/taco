/**
 * McpServerForm — add or edit an MCP server entry.
 *
 * Edit mode receives the FULL `McpServerConfig` (fetched via mcp.getConfig) so
 * the sensitive fields it does not surface (env/headers/url) are preserved on
 * save. onSave returns a full `McpServerConfig` — the caller creates a new
 * server with it (mcp.createConfig) or sends it as a field-wise update patch
 * (mcp.updateConfig; the server merges, so untouched fields survive).
 */
import type { McpServerConfig, McpTransportKind } from "@taco-ai/protocol";
import { MCP_TRANSPORT_KINDS } from "@taco-ai/protocol";
import { useRef } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useT } from "../../i18n/useI18n.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";
import {
    type McpServerDraft,
    mcpServerConfig,
    mcpServerDefaults,
    mcpServerResolver,
} from "./mcpServerFormValues";

const TRANSPORT_LABEL_KEYS = {
    stdio: "settings.mcpServerTransportStdio",
    http: "settings.mcpServerTransportHttp",
} satisfies Record<McpTransportKind, string>;

const TRANSPORT_OPTIONS = MCP_TRANSPORT_KINDS.map((value) => ({
    value,
    labelKey: TRANSPORT_LABEL_KEYS[value],
}));

export interface McpServerFormProps {
    /** Edit mode (existing server) or new (id must not be provided). */
    existing?: McpServerConfig;
    /** Existing id list — new ids must not collide. */
    existingIds: ReadonlyArray<string>;
    /** While saving, both action buttons are disabled to prevent double submits. */
    saving?: boolean;
    onSave: (cfg: McpServerConfig) => void | Promise<void>;
    onCancel: () => void;
}

export function McpServerForm(props: McpServerFormProps) {
    const { t } = useT();
    const isEdit = props.existing !== undefined;

    const {
        register,
        control,
        handleSubmit,
        trigger,
        formState: { errors, isValid, isSubmitting },
    } = useForm<McpServerDraft>({
        defaultValues: mcpServerDefaults(props.existing),
        resolver: mcpServerResolver(props.existingIds, isEdit),
        mode: "onChange",
    });
    const transport = useWatch({ control, name: "transport" });
    const saving = props.saving || isSubmitting;
    const submitting = useRef(false);
    const save = async () => {
        if (props.saving || submitting.current) return;
        submitting.current = true;
        try {
            await handleSubmit(async (values) => {
                await props.onSave(mcpServerConfig(values));
            })();
        } catch {
            // The section presents save errors and keeps this draft open for retry.
        } finally {
            submitting.current = false;
        }
    };

    return (
        <Modal
            open
            onClose={props.onCancel}
            title={isEdit ? t("settings.mcpServerEdit") : t("settings.mcpServerAdd")}
            className="mcp-server-modal"
            actions={
                <>
                    <Button variant="ghost" onClick={props.onCancel} disabled={saving}>
                        {t("settings.mcpServerCancel")}
                    </Button>
                    <Button variant="primary" disabled={!isValid || saving} onClick={save}>
                        {saving ? t("settings.mcpServerSaving") : t("settings.mcpServerSave")}
                    </Button>
                </>
            }
        >
            <FormField
                label={t("settings.mcpServerId")}
                error={
                    errors.id?.type === "duplicate"
                        ? t("settings.mcpServerIdClash")
                        : errors.id?.type === "pattern"
                          ? t("settings.mcpServerIdInvalid")
                          : undefined
                }
            >
                <TextInput
                    type="text"
                    {...register("id")}
                    placeholder="e.g. github, filesystem"
                    disabled={isEdit}
                />
            </FormField>

            <Controller
                control={control}
                name="transport"
                render={({ field }) => (
                    <FormField label={t("settings.mcpServerTransport")}>
                        <Select
                            value={field.value}
                            onValueChange={(value) => {
                                field.onChange(value);
                                void trigger();
                            }}
                            options={TRANSPORT_OPTIONS.map((o) => ({
                                value: o.value,
                                label: t(o.labelKey),
                            }))}
                            label={t("settings.mcpServerTransport")}
                        />
                    </FormField>
                )}
            />

            {transport === "stdio" && (
                <>
                    <FormField
                        label={t("settings.mcpServerCommand")}
                        hint={t("settings.mcpServerCommandHint")}
                    >
                        <TextInput
                            type="text"
                            {...register("command")}
                            placeholder="npx, /usr/local/bin/my-server, …"
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerArgs")}
                        hint={t("settings.mcpServerArgsHint")}
                    >
                        <Textarea
                            {...register("args")}
                            rows={3}
                            placeholder="--flag value\n--option key=value"
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerEnv")}
                        hint={t("settings.mcpServerEnvHint")}
                    >
                        <Textarea
                            {...register("env")}
                            rows={3}
                            placeholder="API_KEY=sk-…\nDEBUG=true"
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerCwd")}
                        hint={t("settings.mcpServerCwdHint")}
                    >
                        <TextInput
                            type="text"
                            {...register("cwd")}
                            placeholder={t("settings.mcpServerCwdPlaceholder")}
                        />
                    </FormField>
                </>
            )}

            {transport === "http" && (
                <>
                    <FormField
                        label={t("settings.mcpServerUrl")}
                        error={
                            errors.url?.type === "validate"
                                ? t("settings.mcpServerUrlInvalid")
                                : undefined
                        }
                    >
                        <TextInput
                            type="text"
                            {...register("url")}
                            placeholder="https://my-mcp-server.example.com/mcp"
                        />
                    </FormField>

                    <FormField
                        label={t("settings.mcpServerHeaders")}
                        hint={t("settings.mcpServerHeadersHint")}
                    >
                        <Textarea
                            {...register("headers")}
                            rows={3}
                            placeholder="Authorization: Bearer sk-…\nX-Custom-Header: value"
                        />
                    </FormField>
                </>
            )}

            <FormField
                label={t("settings.mcpServerTimeout")}
                hint={t("settings.mcpServerTimeoutHint")}
            >
                <TextInput type="text" {...register("timeoutMs")} placeholder="15000" />
            </FormField>

            <FormField
                label={t("settings.mcpServerAlwaysLoaded")}
                hint={t("settings.mcpServerAlwaysLoadedHint")}
            >
                <Textarea
                    {...register("alwaysLoaded")}
                    rows={3}
                    placeholder={t("settings.mcpServerAlwaysLoadedPlaceholder")}
                />
            </FormField>
        </Modal>
    );
}
