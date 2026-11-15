import type { ProviderView } from "@taco-ai/protocol";
import { Pencil, Plus, Trash, Undo2 } from "lucide-react";
import { Fragment, useState } from "react";
import { Controller, type UseFormReturn, useFieldArray, useWatch } from "react-hook-form";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { formatModelWindow, parseModelWindow } from "../../lib/modelWindow.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Tag } from "../ui/Tag.tsx";
import { TextInput } from "../ui/TextInput.tsx";
import {
    modelDraft,
    type ProviderFormDraft,
    WINDOW_CUSTOM,
    WINDOW_DEFAULT,
    WINDOW_PRESETS,
} from "./providerForm.ts";

interface ProviderModelFieldsProps {
    form: UseFormReturn<ProviderFormDraft>;
    client: TacoClient;
    provider?: ProviderView;
    isCustom: boolean;
    saving: boolean;
    staticModels: ProviderView["models"];
}

export function ProviderModelFields({
    form,
    client,
    provider,
    isCustom,
    saving,
    staticModels,
}: ProviderModelFieldsProps) {
    const { t } = useT();
    const { control, register, setValue } = form;
    const [models, hidden, manualId, baseUrl, keyInput, api] = useWatch({
        control,
        name: ["models", "hidden", "manualId", "baseUrl", "keyInput", "api"],
    });
    const { fields, append, remove } = useFieldArray({
        control,
        name: "models",
        rules: { validate: (value) => !isCustom || value.length > 0 },
    });
    const [editedModel, setEditedModel] = useState<string | null>(null);
    const [fetched, setFetched] = useState<string[] | null>(null);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const staticIds = new Set(staticModels.map((model) => model.id));
    const candidates =
        fetched === null
            ? null
            : [
                  ...new Set(
                      fetched.filter(
                          (id) =>
                              !staticIds.has(id) &&
                              !models.some((model) => model.id === id) &&
                              !hidden.includes(id),
                      ),
                  ),
              ];
    const canFetch =
        !fetching &&
        (provider ? provider.configured : baseUrl.trim() !== "" && keyInput.trim() !== "");
    const fetchModels = async () => {
        if (!canFetch) return;
        setFetching(true);
        setFetchError(null);
        try {
            const result = provider
                ? await client.providerListModels({ providerId: provider.id })
                : await client.providerListModels({
                      baseUrl: baseUrl.trim(),
                      api,
                      apiKey: keyInput.trim(),
                  });
            if (!result.ok) setFetchError(result.message);
            else if (result.models.length === 0)
                setFetchError(t("settings.customProviderFetchEmpty"));
            else setFetched(result.models);
        } catch (error) {
            setFetchError(error instanceof Error ? error.message : String(error));
        } finally {
            setFetching(false);
        }
    };
    const addModel = (id: string) => {
        const trimmed = id.trim();
        if (!trimmed || staticIds.has(trimmed) || models.some((model) => model.id === trimmed))
            return;
        append(modelDraft({ id: trimmed }), { shouldFocus: false });
        setValue("manualId", "");
    };
    const hideModel = (id: string) => setValue("hidden", [...hidden, id], { shouldDirty: true });
    const restoreModel = (id: string) =>
        setValue(
            "hidden",
            hidden.filter((value) => value !== id),
            { shouldDirty: true },
        );
    return (
        <>
            <FormField
                label={t("settings.providerDetailModels")}
                group
                action={
                    <Button
                        type="button"
                        size="sm"
                        disabled={!canFetch}
                        onClick={() => void fetchModels()}
                    >
                        {fetching
                            ? t("settings.customProviderFetching")
                            : t("settings.customProviderFetch")}
                    </Button>
                }
                error={fetchError ?? undefined}
                hint={
                    provider !== undefined && !provider.configured
                        ? t("settings.providerFetchNeedKey")
                        : candidates !== null && candidates.length === 0
                          ? t("settings.providerFetchAllKnown")
                          : undefined
                }
            >
                <div className="provider-detail-models">
                    {staticModels.map((m) => (
                        <div className="provider-detail-model-row" key={m.id}>
                            <span className="provider-detail-model-id" title={m.id}>
                                {m.id}
                            </span>
                            <Tag className="provider-row-badge">
                                {t("settings.providerOriginBuiltin")}
                            </Tag>
                            <IconButton
                                size="sm"
                                tone="danger"
                                aria-label={t("settings.providerModelHide")}
                                title={t("settings.providerModelHide")}
                                disabled={saving}
                                onClick={() => hideModel(m.id)}
                            >
                                <Trash size={12} aria-hidden="true" />
                            </IconButton>
                        </div>
                    ))}
                    {fields.map((row, index) => {
                        const m = models[index];
                        if (!m) return null;
                        return (
                            <Fragment key={row.id}>
                                <div className="provider-detail-model-row">
                                    <span className="provider-detail-model-id" title={m.id}>
                                        {m.id}
                                    </span>
                                    {!isCustom && (
                                        <Tag className="provider-row-badge">
                                            {t("settings.providerOriginExtra")}
                                        </Tag>
                                    )}
                                    <Tag
                                        className="provider-row-badge"
                                        title={t("settings.providerModelWindow")}
                                    >
                                        {parseModelWindow(m.windowDraft) === undefined
                                            ? t("settings.providerModelWindowDefault")
                                            : formatModelWindow(
                                                  parseModelWindow(m.windowDraft) as number,
                                              )}
                                    </Tag>
                                    {(m.images === "on" ||
                                        (m.images === "unchanged" &&
                                            m.input?.includes("image"))) && (
                                        <Tag className="provider-row-badge">
                                            {t("settings.providerModelImagesBadge")}
                                        </Tag>
                                    )}
                                    <IconButton
                                        size="sm"
                                        aria-label={t("settings.providerModelWindowEdit")}
                                        title={t("settings.providerModelWindowEdit")}
                                        disabled={saving}
                                        aria-expanded={editedModel === m.id}
                                        onClick={() =>
                                            setEditedModel((cur) => (cur === m.id ? null : m.id))
                                        }
                                    >
                                        <Pencil size={12} aria-hidden="true" />
                                    </IconButton>
                                    <IconButton
                                        size="sm"
                                        tone="danger"
                                        aria-label={t("settings.providerModelRemove")}
                                        title={t("settings.providerModelRemove")}
                                        disabled={saving}
                                        onClick={() => {
                                            remove(index);
                                            if (editedModel === m.id) setEditedModel(null);
                                        }}
                                    >
                                        <Trash size={12} aria-hidden="true" />
                                    </IconButton>
                                </div>
                                {editedModel === m.id && (
                                    <div className="provider-detail-model-editor">
                                        <span className="provider-detail-model-editor-label">
                                            {t("settings.providerModelWindow")}
                                        </span>
                                        {m.windowMode === WINDOW_CUSTOM ? (
                                            <TextInput
                                                {...register(`models.${index}.windowDraft`)}
                                                type="text"
                                                inputMode="numeric"
                                                className="provider-detail-model-window"
                                                placeholder={t(
                                                    "settings.providerModelWindowPlaceholder",
                                                )}
                                                title={t("settings.providerModelWindowTitle")}
                                                autoFocus
                                            />
                                        ) : (
                                            <Controller
                                                control={control}
                                                name={`models.${index}.windowMode`}
                                                render={({ field }) => (
                                                    <Select
                                                        className="provider-detail-model-window"
                                                        label={t("settings.providerModelWindow")}
                                                        value={field.value}
                                                        onValueChange={(value) => {
                                                            field.onChange(value);
                                                            if (value !== WINDOW_CUSTOM) {
                                                                setValue(
                                                                    `models.${index}.windowDraft`,
                                                                    value === WINDOW_DEFAULT
                                                                        ? ""
                                                                        : value,
                                                                    { shouldDirty: true },
                                                                );
                                                            }
                                                        }}
                                                        options={[
                                                            {
                                                                value: WINDOW_DEFAULT,
                                                                label: t(
                                                                    "settings.providerModelWindowDefault",
                                                                ),
                                                            },
                                                            ...WINDOW_PRESETS.map((preset) => ({
                                                                value: String(preset),
                                                                label: formatModelWindow(preset),
                                                            })),
                                                            {
                                                                value: WINDOW_CUSTOM,
                                                                label: t(
                                                                    "settings.providerModelWindowCustom",
                                                                ),
                                                            },
                                                        ]}
                                                    />
                                                )}
                                            />
                                        )}
                                        {/* editedModel opens one editor, so this id stays unique. */}
                                        <span
                                            id="provider-detail-model-images"
                                            className="provider-detail-model-editor-label"
                                        >
                                            {t("settings.providerModelImages")}
                                        </span>
                                        <Controller
                                            control={control}
                                            name={`models.${index}.images`}
                                            render={({ field }) => (
                                                <Switch
                                                    labelledBy="provider-detail-model-images"
                                                    checked={
                                                        field.value === "on" ||
                                                        (field.value === "unchanged" &&
                                                            (m.input?.includes("image") ?? false))
                                                    }
                                                    disabled={saving}
                                                    onChange={(on) =>
                                                        field.onChange(on ? "on" : "off")
                                                    }
                                                />
                                            )}
                                        />
                                    </div>
                                )}
                            </Fragment>
                        );
                    })}
                    {hidden.map((mid) => (
                        <div
                            className="provider-detail-model-row provider-detail-model-row--off"
                            key={mid}
                        >
                            <span className="provider-detail-model-id" title={mid}>
                                {mid}
                            </span>
                            <Tag className="provider-row-badge">
                                {t("settings.providerOriginHidden")}
                            </Tag>
                            <IconButton
                                size="sm"
                                aria-label={t("settings.providerModelRestore")}
                                title={t("settings.providerModelRestore")}
                                disabled={saving}
                                onClick={() => restoreModel(mid)}
                            >
                                <Undo2 size={12} aria-hidden="true" />
                            </IconButton>
                        </div>
                    ))}
                    {isCustom && models.length === 0 && (
                        <div className="provider-detail-empty">
                            {t("settings.providerDetailNoModels")}
                        </div>
                    )}
                </div>
            </FormField>

            {candidates !== null && candidates.length > 0 && (
                <div className="provider-detail-models provider-detail-fetched">
                    {candidates.map((mid) => (
                        <div className="provider-detail-model-row" key={mid}>
                            <span className="provider-detail-model-id" title={mid}>
                                {mid}
                            </span>
                            <IconButton
                                size="sm"
                                aria-label={t("settings.providerModelAdd")}
                                title={t("settings.providerModelAdd")}
                                onClick={() => addModel(mid)}
                            >
                                <Plus size={12} aria-hidden="true" />
                            </IconButton>
                        </div>
                    ))}
                </div>
            )}

            <div className="provider-detail-add-row">
                <TextInput
                    type="text"
                    {...register("manualId")}
                    placeholder={t("settings.providerModelAddPlaceholder")}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            addModel(manualId);
                        }
                    }}
                />
                <Button
                    variant="default"
                    disabled={!manualId.trim()}
                    onClick={() => addModel(manualId)}
                >
                    {t("settings.providerModelAdd")}
                </Button>
            </div>
        </>
    );
}
