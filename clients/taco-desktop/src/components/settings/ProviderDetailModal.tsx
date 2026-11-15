/**
 * ProviderDetailModal — unified edit panel for built-in and custom providers.
 * One modal holds the API key (masked view / reveal / replace), the custom-only
 * fields (name/api/id read-only while editing, baseUrl editable), and the model
 * list (fetch + row-by-row add + manual add + remove user-added entries).
 *
 * Save semantics: built-ins write `apiKeys` + `providerExtraModels` (extras
 * replace the provider's whole extra list); customs replace the whole
 * `customProviders` array. Both are assembled by the caller — this component
 * never touches settings.write directly.
 */
import type {
    CustomModelEntry,
    CustomProviderApi,
    CustomProviderConfig,
    ProviderTestConnectionResult,
    ProviderView,
    WorkspaceId,
} from "@taco-ai/protocol";
import { CUSTOM_PROVIDER_APIS, CUSTOM_PROVIDER_PREFIX } from "@taco-ai/protocol";
import { CircleCheck, CircleX, Eye, EyeOff } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Modal } from "../ui/Modal.tsx";
import { SecretInput } from "../ui/SecretInput.tsx";
import { Select } from "../ui/Select.tsx";
import { TextInput } from "../ui/TextInput.tsx";

import { ProviderModelFields } from "./ProviderModelFields.tsx";
import { modelPayload, type ProviderFormDraft, providerDefaults } from "./providerForm.ts";

export interface ProviderDetailModalProps {
    client: TacoClient;
    /** Current workspace — providers.revealKey is workspace-scoped. */
    workspace: WorkspaceId;
    /** Saved provider view; undefined in create-custom mode. */
    provider?: ProviderView;
    /** Custom provider config (custom edit mode). */
    cfg?: CustomProviderConfig;
    /** Existing custom ids — new ids must not collide. */
    existingIds: ReadonlyArray<string>;
    /** Masked key from the sidecar view (e.g. `sk-ant-…AbCd`). */
    mask?: string;
    /**
     * Configured default provider id. Used only to warn that deleting this
     * provider will reset the default model.
     */
    defaultProvider?: string;
    saving: boolean;
    /** Save error from the caller's save hook — shown inside the modal. */
    saveError?: string | null;
    /**
     * Built-in save: optional new key (undefined = keep), the full extras list,
     * and the full hidden-static list (empty = nothing hidden).
     */
    onSaveBuiltin?: (
        apiKey: string | undefined,
        extras: CustomModelEntry[],
        hidden: string[],
    ) => void | Promise<void>;
    /** Custom save: whole provider config + optional new key ("" = keep/none). */
    onSaveCustom?: (cfg: CustomProviderConfig, apiKey: string) => void | Promise<void>;
    onDeleteCustom?: () => Promise<void>;
    onClose: () => void;
}

const PROTOCOL_LABEL_KEYS = {
    chatcomplete: "settings.customProviderApiChatcomplete",
    response: "settings.customProviderApiResponse",
    anthropic: "settings.customProviderApiAnthropic",
} satisfies Record<CustomProviderApi, string>;

const PROTOCOL_OPTIONS = CUSTOM_PROVIDER_APIS.map((value) => ({
    value,
    labelKey: PROTOCOL_LABEL_KEYS[value],
}));

export function ProviderDetailModal(props: ProviderDetailModalProps) {
    const { t } = useT();
    const provider = props.provider;
    const isCreate = provider === undefined;
    const isCustom = isCreate || provider.custom;

    const defaultValues = useMemo(
        () => providerDefaults(provider, props.cfg),
        [provider, props.cfg],
    );
    const form = useForm<ProviderFormDraft>({
        mode: "onChange",
        defaultValues,
    });
    const {
        register,
        control,
        handleSubmit,
        formState: { isValid, isSubmitting, errors },
    } = form;
    const [api, baseUrl, keyInput, models, hidden] = useWatch({
        control,
        name: ["api", "baseUrl", "keyInput", "models", "hidden"],
    });
    const saving = props.saving || isSubmitting;

    const [keyMode, setKeyMode] = useState<"view" | "edit">(provider?.configured ? "view" : "edit");
    const [revealedKey, setRevealedKey] = useState<string | null>(null);
    const [revealing, setRevealing] = useState(false);

    // Visible static rows = catalog entries minus every hidden id, including
    // the ones hidden in this session (the server view only reflects saves).
    const staticModels = isCustom
        ? []
        : (provider?.models ?? []).filter(
              (m) => m.origin !== "extra" && m.origin !== "hidden" && !hidden.includes(m.id),
          );

    const trimmedBaseUrl = baseUrl.trim();

    // Connection test: every model the user could pick, in list order.
    const testableModels = [...staticModels.map((m) => m.id), ...models.map((m) => m.id)];
    const [testModelPick, setTestModelPick] = useState<string>("");
    // Fall back to the first model when the pick was removed from the list.
    const testModel = testableModels.includes(testModelPick)
        ? testModelPick
        : (testableModels[0] ?? "");
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<ProviderTestConnectionResult | null>(null);
    // A typed key is tested as-is, before saving; otherwise the stored key.
    const typedKey = keyMode === "edit" ? keyInput.trim() : "";
    const hasKey = typedKey !== "" || (provider?.configured ?? false);
    const canTest =
        !testing &&
        testModel !== "" &&
        hasKey &&
        (isCreate ? trimmedBaseUrl !== "" && typedKey !== "" : true);

    const testConnection = async () => {
        if (!canTest) return;
        setTesting(true);
        setTestResult(null);
        try {
            const result = isCreate
                ? await props.client.providerTestConnection({
                      baseUrl: trimmedBaseUrl,
                      api,
                      apiKey: typedKey,
                      modelId: testModel,
                  })
                : await props.client.providerTestConnection({
                      providerId: provider?.id ?? "",
                      modelId: testModel,
                      ...(typedKey ? { apiKey: typedKey } : {}),
                  });
            setTestResult(result);
        } catch (e) {
            // Transport-level failure (sidecar down, invalid params) — shown in
            // the same slot as a probe failure so the user sees one outcome.
            setTestResult({
                ok: false,
                reason: "error",
                message: e instanceof Error ? e.message : String(e),
                latencyMs: 0,
            });
        } finally {
            setTesting(false);
        }
    };

    const toggleReveal = async () => {
        if (!provider) return;
        if (revealedKey !== null) {
            setRevealedKey(null);
            return;
        }
        setRevealing(true);
        try {
            const res = await props.client.providersRevealKey({
                workspace: props.workspace,
                providerId: provider.id,
            });
            // null = store lost the key since the view was fetched; stay masked.
            if (res.key) setRevealedKey(res.key);
        } catch {
            // Reveal failure keeps the masked view; nothing sensitive to report.
        } finally {
            setRevealing(false);
        }
    };

    const submitLock = useRef(false);
    const saveDraft = handleSubmit(async (draft) => {
        const payloadModels = draft.models.map(modelPayload);
        try {
            if (isCustom) {
                await props.onSaveCustom?.(
                    {
                        id: draft.id,
                        name: draft.name.trim(),
                        api: draft.api,
                        baseUrl: draft.baseUrl.trim(),
                        models: payloadModels,
                    },
                    draft.keyInput.trim(),
                );
            } else {
                // Only explicitly typed secrets can replace the stored key.
                const newKey = keyMode === "edit" ? draft.keyInput.trim() || undefined : undefined;
                await props.onSaveBuiltin?.(newKey, payloadModels, draft.hidden);
            }
        } catch {
            // The caller supplies saveError; retain the draft for retry.
        }
    });

    const submit = async () => {
        // RHF updates isSubmitting on render; the lock also covers same-batch events.
        if (saving || submitLock.current) return;
        submitLock.current = true;
        try {
            await saveDraft();
        } finally {
            submitLock.current = false;
        }
    };

    const title = isCreate ? t("settings.customProviderAdd") : (provider?.name ?? "");

    /**
     * Deleting the configured default provider is the one destructive action
     * here that reaches past this panel: it can strand `defaultProvider` and
     * break session creation for every later prompt. Gate it behind a confirm
     * that names the consequence when it applies.
     */
    const isDefaultProvider =
        !isCreate && provider !== undefined && props.defaultProvider === provider.id;
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    return (
        <Modal
            open
            onClose={props.onClose}
            title={title}
            className="provider-detail-modal"
            actions={
                <>
                    {isCustom && !isCreate && (
                        <Button
                            variant="danger"
                            className="provider-detail-delete"
                            disabled={saving}
                            onClick={() => setConfirmingDelete(true)}
                        >
                            {t("settings.customProviderDeleteBtn")}
                        </Button>
                    )}
                    <Button variant="ghost" disabled={saving} onClick={props.onClose}>
                        {t("settings.providerCancel")}
                    </Button>
                    <Button
                        variant="primary"
                        disabled={saving || !isValid}
                        onClick={() => void submit()}
                    >
                        {t("settings.providerSaveKey")}
                    </Button>
                </>
            }
        >
            <FormField
                label={t("settings.providerDetailKey")}
                group={keyMode === "view" && provider !== undefined}
                hint={
                    keyMode === "edit" && provider?.configured
                        ? t("settings.providerDetailKeepKey")
                        : undefined
                }
            >
                {keyMode === "view" && provider ? (
                    <div className="provider-detail-key-view">
                        <span className="provider-detail-key-mask">
                            {revealedKey ?? props.mask ?? ""}
                        </span>
                        <IconButton
                            size="sm"
                            aria-label={
                                revealedKey !== null
                                    ? t("settings.providerDetailHide")
                                    : t("settings.providerDetailReveal")
                            }
                            title={
                                revealedKey !== null
                                    ? t("settings.providerDetailHide")
                                    : t("settings.providerDetailReveal")
                            }
                            aria-pressed={revealedKey !== null}
                            disabled={revealing}
                            onClick={() => void toggleReveal()}
                        >
                            {revealedKey !== null ? (
                                <EyeOff size={13} aria-hidden="true" />
                            ) : (
                                <Eye size={13} aria-hidden="true" />
                            )}
                        </IconButton>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setKeyMode("edit");
                                setRevealedKey(null);
                            }}
                        >
                            {t("settings.providerReplaceKey")}
                        </Button>
                    </div>
                ) : (
                    <SecretInput
                        {...register("keyInput")}
                        placeholder={t("settings.providerKeyPlaceholder")}
                        autoComplete="off"
                        revealLabel={t("settings.providerDetailReveal")}
                        hideLabel={t("settings.providerDetailHide")}
                    />
                )}
            </FormField>

            {isCustom && (
                <>
                    <FormField label={t("settings.customProviderName")}>
                        <TextInput
                            type="text"
                            {...register("name", {
                                validate: (value) => !isCustom || value.trim() !== "",
                            })}
                            placeholder={t("settings.customProviderNamePlaceholder")}
                            disabled={!isCreate}
                        />
                    </FormField>
                    <FormField
                        label={t("settings.customProviderId")}
                        error={
                            errors.id?.type === "clash"
                                ? t("settings.customProviderIdClash")
                                : undefined
                        }
                    >
                        <TextInput
                            type="text"
                            {...register("id", {
                                validate: {
                                    prefix: (value) =>
                                        !isCustom || value.startsWith(CUSTOM_PROVIDER_PREFIX),
                                    clash: (value) =>
                                        !isCreate || !props.existingIds.includes(value),
                                },
                            })}
                            disabled={!isCreate}
                        />
                    </FormField>
                    <Controller
                        control={control}
                        name="api"
                        render={({ field }) => (
                            <FormField label={t("settings.customProviderApi")}>
                                <Select
                                    className="provider-api-select"
                                    value={field.value}
                                    disabled={!isCreate}
                                    onValueChange={field.onChange}
                                    options={PROTOCOL_OPTIONS.map((opt) => ({
                                        value: opt.value,
                                        label: t(opt.labelKey),
                                    }))}
                                    label={t("settings.customProviderApi")}
                                />
                            </FormField>
                        )}
                    />
                    <FormField label={t("settings.customProviderBaseUrl")}>
                        <TextInput
                            type="text"
                            {...register("baseUrl", {
                                validate: (value) => !isCustom || value.trim() !== "",
                            })}
                            placeholder={t("settings.customProviderBaseUrlPlaceholder")}
                        />
                    </FormField>
                </>
            )}

            {!isCustom && (
                <>
                    {/* Built-ins keep pi's endpoint and protocol — shown read-only
                        so the user can see which host a key is sent to. */}
                    <FormField
                        label={t("settings.customProviderApi")}
                        hint={t("settings.providerBuiltinEndpointHint")}
                    >
                        <Select
                            className="provider-api-select"
                            value={provider?.api ?? "chatcomplete"}
                            disabled
                            onValueChange={() => {}}
                            options={PROTOCOL_OPTIONS.map((opt) => ({
                                value: opt.value,
                                label: t(opt.labelKey),
                            }))}
                            label={t("settings.customProviderApi")}
                        />
                    </FormField>
                    <FormField label={t("settings.customProviderBaseUrl")}>
                        <TextInput type="text" value={provider?.baseUrl ?? ""} readOnly />
                    </FormField>
                </>
            )}

            <ProviderModelFields
                form={form}
                client={props.client}
                provider={provider}
                isCustom={isCustom}
                saving={saving}
                staticModels={staticModels}
            />

            <FormField
                label={t("settings.providerTestTitle")}
                group
                hint={
                    testableModels.length === 0
                        ? t("settings.providerTestNeedModel")
                        : !hasKey
                          ? t("settings.providerTestNeedKey")
                          : t("settings.providerTestHint")
                }
            >
                <div className="provider-detail-test-row">
                    <Select
                        value={testModel}
                        disabled={testing || testableModels.length === 0}
                        onValueChange={setTestModelPick}
                        options={testableModels}
                        placeholder={t("settings.providerTestModel")}
                        label={t("settings.providerTestModel")}
                    />
                    <Button
                        variant="default"
                        disabled={!canTest}
                        onClick={() => void testConnection()}
                    >
                        {testing ? t("settings.providerTesting") : t("settings.providerTestButton")}
                    </Button>
                </div>
            </FormField>
            {testResult && (
                <div
                    className={`provider-detail-test-result provider-detail-test-result--${
                        testResult.ok ? "ok" : "fail"
                    }`}
                    role="status"
                >
                    {testResult.ok ? (
                        <CircleCheck size={14} aria-hidden="true" />
                    ) : (
                        <CircleX size={14} aria-hidden="true" />
                    )}
                    <div className="provider-detail-test-text">
                        <span className="provider-detail-test-headline">
                            {testResult.ok
                                ? t("settings.providerTestOk", { ms: testResult.latencyMs })
                                : t(`settings.providerTestFail_${testResult.reason}`)}
                        </span>
                        <span className="provider-detail-test-detail">
                            {testResult.ok
                                ? testResult.reply
                                    ? `${testResult.model} · “${testResult.reply}”`
                                    : testResult.model
                                : testResult.message}
                        </span>
                    </div>
                </div>
            )}

            {props.saveError && (
                <div className="error-banner" role="alert">
                    {props.saveError}
                </div>
            )}

            {isCustom && !isCreate && (
                <ConfirmModal
                    open={confirmingDelete}
                    title={t("settings.customProviderDeleteConfirm")}
                    message={t(
                        isDefaultProvider
                            ? "settings.customProviderDeleteConfirmDefault"
                            : "settings.customProviderDeleteConfirmPlain",
                    )}
                    confirmLabel={t("settings.customProviderDeleteConfirmBtn")}
                    cancelLabel={t("settings.providerCancel")}
                    tone="danger"
                    busy={saving}
                    onConfirm={() => {
                        setConfirmingDelete(false);
                        void props.onDeleteCustom?.();
                    }}
                    onCancel={() => setConfirmingDelete(false)}
                />
            )}
        </Modal>
    );
}
