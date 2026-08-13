/**
 * CustomProviderForm — add/edit a custom provider, as its own modal dialog.
 * Custom ids carry the `custom:` prefix; api key lands in `apiKeys[id]`.
 * Submission replaces the full `customProviders` array via one atomic
 * settings.write — callers upsert/edit before calling onSave.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { CustomModelEntry, CustomProviderApi, CustomProviderConfig } from "@taco-ai/protocol";
import { CUSTOM_PROVIDER_PREFIX } from "@taco-ai/protocol";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/tacoClientTauri.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Select } from "../ui/Select.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { TextInput } from "../ui/TextInput.tsx";

export interface CustomProviderFormProps {
    /** Edit mode (existing provider) or new (id auto-generated) */
    existing?: CustomProviderConfig;
    /** Existing id list — new ids must not collide with any of these. */
    existingIds: ReadonlyArray<string>;
    /** Used for the `provider.listModels` fetch behind the "Fetch models" button. */
    client: TacoClient;
    onSave: (cfg: CustomProviderConfig, apiKey: string) => void;
    onCancel: () => void;
}

/** Model-id discovery is only available on the OpenAI-compatible protocol. */
const MODEL_FETCH_API: CustomProviderApi = "chatcomplete";

const PROTOCOL_OPTIONS: ReadonlyArray<{ value: CustomProviderApi; labelKey: string }> = [
    { value: "chatcomplete", labelKey: "settings.customProviderApiChatcomplete" },
    { value: "response", labelKey: "settings.customProviderApiResponse" },
    { value: "anthropic", labelKey: "settings.customProviderApiAnthropic" },
];

/** Default id for new providers (`custom:<first 8 chars of uuid>`). Uses
 * crypto.randomUUID() to avoid the unpredictable collisions of 6-char base36
 * Math.random() ids. The backend's validateCustomProviders still rejects
 * duplicates by id; this front-end fallback only covers the local experience
 * before a duplicate submit fires.
 */
function defaultId(): string {
    const slug = crypto.randomUUID().slice(0, 8);
    return `${CUSTOM_PROVIDER_PREFIX}${slug}`;
}

export function CustomProviderForm(props: CustomProviderFormProps) {
    const { t } = useT();
    const isEdit = props.existing !== undefined;

    const [id, setId] = useState(props.existing?.id ?? defaultId());
    const [name, setName] = useState(props.existing?.name ?? "");
    const [api, setApi] = useState<CustomProviderApi>(props.existing?.api ?? "chatcomplete");
    const [baseUrl, setBaseUrl] = useState(props.existing?.baseUrl ?? "");
    const [modelsText, setModelsText] = useState(
        (props.existing?.models ?? []).map((m) => m.id).join("\n"),
    );
    const [apiKey, setApiKey] = useState("");
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);

    const idClash = !isEdit && props.existingIds.includes(id);
    const trimmedName = name.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const modelIds = modelsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    // Discovery needs a base URL and a key to authenticate with; the button
    // stays disabled until both are present.
    const canFetchModels =
        api === MODEL_FETCH_API && trimmedBaseUrl !== "" && apiKey.trim() !== "" && !fetching;

    const fetchModels = async () => {
        setFetching(true);
        setFetchError(null);
        try {
            const result = await props.client.providerListModels({
                baseUrl: trimmedBaseUrl,
                api,
                apiKey: apiKey.trim(),
            });
            if (!result.ok) {
                setFetchError(result.message);
                return;
            }
            if (result.models.length === 0) {
                setFetchError(t("settings.customProviderFetchEmpty"));
                return;
            }
            // Append only ids we don't already list, preserving what the user typed.
            const existing = new Set(modelIds);
            const added = result.models.filter((m) => !existing.has(m));
            if (added.length === 0) return;
            setModelsText([...modelIds, ...added].join("\n"));
        } catch (e) {
            setFetchError(e instanceof Error ? e.message : String(e));
        } finally {
            setFetching(false);
        }
    };
    const canSave =
        trimmedName !== "" &&
        trimmedBaseUrl !== "" &&
        modelIds.length > 0 &&
        id.startsWith(CUSTOM_PROVIDER_PREFIX) &&
        !idClash;

    const save = () => {
        if (!canSave) return;
        const models: CustomModelEntry[] = modelIds.map((mid) => ({ id: mid }));
        props.onSave(
            {
                id,
                name: trimmedName,
                api,
                baseUrl: trimmedBaseUrl,
                models,
            },
            apiKey.trim(),
        );
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
                <Dialog.Content className="modal custom-provider-modal">
                    <Dialog.Title className="modal-title">
                        {isEdit
                            ? t("settings.customProviderEdit")
                            : t("settings.customProviderAdd")}
                    </Dialog.Title>

                    <FormField label={t("settings.customProviderName")}>
                        <TextInput
                            type="text"
                            value={name}
                            placeholder={t("settings.customProviderNamePlaceholder")}
                            disabled={isEdit}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </FormField>

                    <FormField
                        label={t("settings.customProviderId")}
                        error={idClash ? t("settings.customProviderIdClash") : undefined}
                    >
                        <TextInput
                            type="text"
                            value={id}
                            disabled={isEdit}
                            onChange={(e) => setId(e.target.value)}
                        />
                    </FormField>

                    <FormField label={t("settings.customProviderApi")}>
                        <Select
                            value={api}
                            disabled={isEdit}
                            onValueChange={(v) => setApi(v as CustomProviderApi)}
                            options={PROTOCOL_OPTIONS.map((opt) => ({
                                value: opt.value,
                                label: t(opt.labelKey),
                            }))}
                            label={t("settings.customProviderApi")}
                        />
                    </FormField>

                    <FormField label={t("settings.customProviderBaseUrl")}>
                        <TextInput
                            type="text"
                            value={baseUrl}
                            placeholder={t("settings.customProviderBaseUrlPlaceholder")}
                            onChange={(e) => setBaseUrl(e.target.value)}
                        />
                    </FormField>

                    <FormField
                        label={t("settings.customProviderModelsLabel")}
                        action={
                            api === MODEL_FETCH_API ? (
                                <button
                                    type="button"
                                    className="custom-provider-fetch-btn"
                                    disabled={!canFetchModels}
                                    onClick={() => void fetchModels()}
                                >
                                    {fetching
                                        ? t("settings.customProviderFetching")
                                        : t("settings.customProviderFetch")}
                                </button>
                            ) : (
                                <span className="custom-provider-fetch-hint">
                                    {t("settings.customProviderFetchUnsupported")}
                                </span>
                            )
                        }
                        error={fetchError ?? undefined}
                    >
                        <Textarea
                            value={modelsText}
                            rows={4}
                            placeholder={t("settings.customProviderModelsPlaceholder")}
                            onChange={(e) => setModelsText(e.target.value)}
                        />
                    </FormField>

                    <FormField label={t("settings.customProviderKeyLabel")}>
                        <TextInput
                            type="password"
                            value={apiKey}
                            placeholder={t("settings.customProviderKeyPlaceholder")}
                            autoComplete="off"
                            onChange={(e) => setApiKey(e.target.value)}
                        />
                    </FormField>

                    <div className="modal-actions">
                        <Button variant="ghost" onClick={props.onCancel}>
                            {t("settings.customProviderCancel")}
                        </Button>
                        <Button variant="primary" disabled={!canSave} onClick={save}>
                            {t("settings.customProviderSave")}
                        </Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
