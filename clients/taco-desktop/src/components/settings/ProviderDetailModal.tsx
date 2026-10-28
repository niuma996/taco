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
import { CUSTOM_PROVIDER_PREFIX } from "@taco-ai/protocol";
import { CircleCheck, CircleX, Eye, EyeOff, Pencil, Plus, Trash, Undo2 } from "lucide-react";
import { Fragment, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { formatModelWindow, parseModelWindow } from "../../lib/modelWindow.ts";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Modal } from "../ui/Modal.tsx";
import { SecretInput } from "../ui/SecretInput.tsx";
import { Select } from "../ui/Select.tsx";
import { TextInput } from "../ui/TextInput.tsx";

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
    ) => Promise<void>;
    /** Custom save: whole provider config + optional new key ("" = keep/none). */
    onSaveCustom?: (cfg: CustomProviderConfig, apiKey: string) => Promise<void>;
    onDeleteCustom?: () => Promise<void>;
    onClose: () => void;
}

const PROTOCOL_OPTIONS: ReadonlyArray<{ value: CustomProviderApi; labelKey: string }> = [
    { value: "chatcomplete", labelKey: "settings.customProviderApiChatcomplete" },
    { value: "response", labelKey: "settings.customProviderApiResponse" },
    { value: "anthropic", labelKey: "settings.customProviderApiAnthropic" },
];

/** Common context-window presets offered in the model rows. The "k" = 1000
 *  convention matches parseModelWindow, so a preset round-trips through the
 *  free-text input. */
const WINDOW_PRESETS = [32_000, 128_000, 200_000, 256_000, 512_000, 1_000_000] as const;
const WINDOW_DEFAULT = "default";
const WINDOW_CUSTOM = "custom";

/** Default id for new providers (`custom:<first 8 chars of uuid>`). */
function defaultId(): string {
    const slug = crypto.randomUUID().slice(0, 8);
    return `${CUSTOM_PROVIDER_PREFIX}${slug}`;
}

export function ProviderDetailModal(props: ProviderDetailModalProps) {
    const { t } = useT();
    const provider = props.provider;
    const isCreate = provider === undefined;
    const isCustom = isCreate || provider.custom;

    // Custom fields — name/api/id freeze once created (pi keys providers by id).
    const [id, setId] = useState(props.cfg?.id ?? defaultId());
    const [name, setName] = useState(props.cfg?.name ?? "");
    const [api, setApi] = useState<CustomProviderApi>(props.cfg?.api ?? "chatcomplete");
    const [baseUrl, setBaseUrl] = useState(props.cfg?.baseUrl ?? "");

    const [keyMode, setKeyMode] = useState<"view" | "edit">(provider?.configured ? "view" : "edit");
    const [keyInput, setKeyInput] = useState("");
    const [revealedKey, setRevealedKey] = useState<string | null>(null);
    const [revealing, setRevealing] = useState(false);

    // Models the user manages in this modal: extras for built-ins, the whole
    // list for customs. Built-in static rows render separately — removable,
    // with hidden ones offered back for restore. The entries keep the
    // declared window so a save does not silently reset it to the default.
    const [models, setModels] = useState<CustomModelEntry[]>(() => {
        if (isCreate) return [];
        if (isCustom) return props.cfg?.models ?? [];
        return (provider?.models ?? [])
            .filter((m) => m.origin === "extra")
            .map((m) => ({
                id: m.id,
                // The catalog falls back to the id when the user declared no
                // display name, so only a name that differs from the id is a
                // real one — and it has to survive the save, or opening the
                // panel would rewrite the entry as a bare id.
                ...(m.name !== undefined && m.name !== m.id ? { name: m.name } : {}),
                ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
                ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
                // A declared thinking flag must survive a save: dropping it
                // would let the model fall back to the provider's default.
                ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
            }));
    });
    const [hidden, setHidden] = useState<string[]>(() =>
        isCustom
            ? []
            : (provider?.models ?? []).filter((m) => m.origin === "hidden").map((m) => m.id),
    );
    // Ids from the last fetch that are not yet in the list — shown row-by-row
    // with an add button; stays until the user adds or re-fetches.
    const [fetched, setFetched] = useState<string[] | null>(null);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [manualId, setManualId] = useState("");

    // Visible static rows = catalog entries minus every hidden id, including
    // the ones hidden in this session (the server view only reflects saves).
    const staticModels = isCustom
        ? []
        : (provider?.models ?? []).filter(
              (m) => m.origin !== "extra" && m.origin !== "hidden" && !hidden.includes(m.id),
          );
    const staticIds = new Set(staticModels.map((m) => m.id));

    /**
     * Fetch candidates, filtered on every render rather than snapshotted at
     * fetch time: the user can add or hide models after a fetch, and a stale
     * snapshot would keep offering ids that are already in the list. Deduped
     * too — an endpoint that repeats an id would otherwise render two rows
     * with the same React key.
     */
    const candidates =
        fetched === null
            ? null
            : [
                  ...new Set(
                      fetched.filter(
                          (m) =>
                              !staticIds.has(m) &&
                              !models.some((x) => x.id === m) &&
                              !hidden.includes(m),
                      ),
                  ),
              ];

    const idClash = isCreate && props.existingIds.includes(id);
    const trimmedName = name.trim();
    const trimmedBaseUrl = baseUrl.trim();

    // Saved providers resolve baseUrl/api/key server-side; the create form
    // still needs the literal endpoint + typed key.
    const canFetch = isCreate
        ? trimmedBaseUrl !== "" && keyInput.trim() !== "" && !fetching
        : (provider?.configured ?? false) && !fetching;

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
            const res = await props.client.providersRevealKey(props.workspace, provider.id);
            // null = store lost the key since the view was fetched; stay masked.
            if (res.key) setRevealedKey(res.key);
        } catch {
            // Reveal failure keeps the masked view; nothing sensitive to report.
        } finally {
            setRevealing(false);
        }
    };

    const fetchModels = async () => {
        setFetching(true);
        setFetchError(null);
        try {
            const result = isCreate
                ? await props.client.providerListModels({
                      baseUrl: trimmedBaseUrl,
                      api,
                      apiKey: keyInput.trim(),
                  })
                : await props.client.providerListModels({ providerId: provider?.id ?? "" });
            if (!result.ok) {
                setFetchError(result.message);
                return;
            }
            if (result.models.length === 0) {
                setFetchError(t("settings.customProviderFetchEmpty"));
                return;
            }
            // Stored raw; the visible candidate list is derived per render.
            setFetched(result.models);
        } catch (e) {
            setFetchError(e instanceof Error ? e.message : String(e));
        } finally {
            setFetching(false);
        }
    };

    const addModel = (mid: string) => {
        const trimmed = mid.trim();
        if (!trimmed || staticIds.has(trimmed) || models.some((m) => m.id === trimmed)) return;
        setModels([...models, { id: trimmed }]);
        setManualId("");
    };

    const removeModel = (mid: string) => {
        setModels(models.filter((m) => m.id !== mid));
        setEditedModel((cur) => (cur === mid ? null : cur));
        setWindowModes((d) => {
            const { [mid]: _drop, ...rest } = d;
            return rest;
        });
    };

    /**
     * Declare the model's context window. Empty / unparsable clears it, which
     * puts the model back on the server-side default — the field is optional
     * because a catalog model already knows its own window.
     */
    const writeModelWindow = (mid: string, contextWindow: number | undefined) => {
        setModels(
            models.map((m) => {
                if (m.id !== mid) return m;
                const { contextWindow: _drop, ...rest } = m;
                return contextWindow === undefined ? rest : { ...rest, contextWindow };
            }),
        );
    };

    /** Raw text of the custom-window input, kept while it does not parse —
     *  without it, invalid keystrokes would vanish on the controlled re-render. */
    const [windowDrafts, setWindowDrafts] = useState<Record<string, string>>({});
    /** Picker mode per model ("default" / a preset / "custom"). Explicit
     *  state — choosing "custom" must stick even with no value declared yet,
     *  which a value-derived mode cannot express. */
    const [windowModes, setWindowModes] = useState<Record<string, string>>({});
    /** Which model row has its window editor expanded; one at a time. */
    const [editedModel, setEditedModel] = useState<string | null>(null);

    /** Which control the window slot renders for this model: a preset, the
     *  server default, or the free-text input (a draft or a non-preset value). */
    const windowMode = (m: CustomModelEntry): string => {
        if (windowModes[m.id] !== undefined) return windowModes[m.id];
        if (m.contextWindow === undefined) return WINDOW_DEFAULT;
        return WINDOW_PRESETS.includes(m.contextWindow as (typeof WINDOW_PRESETS)[number])
            ? String(m.contextWindow)
            : WINDOW_CUSTOM;
    };

    const onWindowModeChange = (m: CustomModelEntry, value: string) => {
        setWindowModes((d) => ({ ...d, [m.id]: value }));
        setWindowDrafts((d) => {
            const { [m.id]: _drop, ...rest } = d;
            return rest;
        });
        if (value === WINDOW_DEFAULT) {
            writeModelWindow(m.id, undefined);
        } else if (value !== WINDOW_CUSTOM) {
            writeModelWindow(m.id, Number(value));
        }
    };

    const onWindowDraftChange = (m: CustomModelEntry, raw: string) => {
        setWindowDrafts((d) => ({ ...d, [m.id]: raw }));
        writeModelWindow(m.id, parseModelWindow(raw));
    };

    const hideModel = (mid: string) => {
        setHidden([...hidden, mid]);
    };

    const restoreModel = (mid: string) => {
        setHidden(hidden.filter((x) => x !== mid));
    };

    const canSave = isCustom
        ? trimmedName !== "" &&
          trimmedBaseUrl !== "" &&
          models.length > 0 &&
          id.startsWith(CUSTOM_PROVIDER_PREFIX) &&
          !idClash
        : true;

    const submit = async () => {
        if (!canSave || props.saving) return;
        try {
            if (isCustom) {
                await props.onSaveCustom?.(
                    {
                        id,
                        name: trimmedName,
                        api,
                        baseUrl: trimmedBaseUrl,
                        models,
                    },
                    keyInput.trim(),
                );
            } else {
                // Edit mode with a typed key replaces it; view mode (or an empty
                // field) leaves the stored key untouched.
                const newKey =
                    keyMode === "edit" && keyInput.trim() !== "" ? keyInput.trim() : undefined;
                await props.onSaveBuiltin?.(newKey, models, hidden);
            }
        } catch {
            // Surfaced through the caller's saveError prop; keep the modal open.
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
                            disabled={props.saving}
                            onClick={() => setConfirmingDelete(true)}
                        >
                            {t("settings.customProviderDeleteBtn")}
                        </Button>
                    )}
                    <Button variant="ghost" disabled={props.saving} onClick={props.onClose}>
                        {t("settings.providerCancel")}
                    </Button>
                    <Button
                        variant="primary"
                        disabled={props.saving || !canSave}
                        onClick={() => void submit()}
                    >
                        {t("settings.providerSaveKey")}
                    </Button>
                </>
            }
        >
            <FormField
                label={t("settings.providerDetailKey")}
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
                        value={keyInput}
                        placeholder={t("settings.providerKeyPlaceholder")}
                        autoComplete="off"
                        revealLabel={t("settings.providerDetailReveal")}
                        hideLabel={t("settings.providerDetailHide")}
                        onChange={(e) => setKeyInput(e.target.value)}
                    />
                )}
            </FormField>

            {isCustom && (
                <>
                    <FormField label={t("settings.customProviderName")}>
                        <TextInput
                            type="text"
                            value={name}
                            placeholder={t("settings.customProviderNamePlaceholder")}
                            disabled={!isCreate}
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
                            disabled={!isCreate}
                            onChange={(e) => setId(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t("settings.customProviderApi")}>
                        <Select
                            value={api}
                            disabled={!isCreate}
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

            <FormField
                label={t("settings.providerDetailModels")}
                action={
                    <button
                        type="button"
                        className="provider-detail-fetch-btn"
                        disabled={!canFetch}
                        onClick={() => void fetchModels()}
                    >
                        {fetching
                            ? t("settings.customProviderFetching")
                            : t("settings.customProviderFetch")}
                    </button>
                }
                error={fetchError ?? undefined}
                hint={
                    !isCreate && !provider?.configured
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
                            <span className="provider-row-badge">
                                {t("settings.providerOriginBuiltin")}
                            </span>
                            <IconButton
                                size="sm"
                                tone="danger"
                                aria-label={t("settings.providerModelHide")}
                                title={t("settings.providerModelHide")}
                                disabled={props.saving}
                                onClick={() => hideModel(m.id)}
                            >
                                <Trash size={12} aria-hidden="true" />
                            </IconButton>
                        </div>
                    ))}
                    {models.map((m) => (
                        <Fragment key={m.id}>
                            <div className="provider-detail-model-row">
                                <span className="provider-detail-model-id" title={m.id}>
                                    {m.id}
                                </span>
                                {!isCustom && (
                                    <span className="provider-row-badge">
                                        {t("settings.providerOriginExtra")}
                                    </span>
                                )}
                                <span
                                    className="provider-row-badge"
                                    title={t("settings.providerModelWindow")}
                                >
                                    {m.contextWindow === undefined
                                        ? t("settings.providerModelWindowDefault")
                                        : formatModelWindow(m.contextWindow)}
                                </span>
                                <IconButton
                                    size="sm"
                                    aria-label={t("settings.providerModelWindowEdit")}
                                    title={t("settings.providerModelWindowEdit")}
                                    disabled={props.saving}
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
                                    disabled={props.saving}
                                    onClick={() => removeModel(m.id)}
                                >
                                    <Trash size={12} aria-hidden="true" />
                                </IconButton>
                            </div>
                            {editedModel === m.id && (
                                <div className="provider-detail-model-editor">
                                    <span className="provider-detail-model-editor-label">
                                        {t("settings.providerModelWindow")}
                                    </span>
                                    {windowMode(m) === WINDOW_CUSTOM ? (
                                        <TextInput
                                            type="text"
                                            inputMode="numeric"
                                            className="provider-detail-model-window"
                                            value={
                                                windowDrafts[m.id] ??
                                                m.contextWindow?.toString() ??
                                                ""
                                            }
                                            placeholder={t(
                                                "settings.providerModelWindowPlaceholder",
                                            )}
                                            title={t("settings.providerModelWindowTitle")}
                                            autoFocus
                                            onChange={(e) => onWindowDraftChange(m, e.target.value)}
                                        />
                                    ) : (
                                        <Select
                                            className="provider-detail-model-window"
                                            label={t("settings.providerModelWindow")}
                                            value={windowMode(m)}
                                            onValueChange={(v) => onWindowModeChange(m, v)}
                                            options={[
                                                {
                                                    value: WINDOW_DEFAULT,
                                                    label: t("settings.providerModelWindowDefault"),
                                                },
                                                ...WINDOW_PRESETS.map((p) => ({
                                                    value: String(p),
                                                    label: formatModelWindow(p),
                                                })),
                                                {
                                                    value: WINDOW_CUSTOM,
                                                    label: t("settings.providerModelWindowCustom"),
                                                },
                                            ]}
                                        />
                                    )}
                                </div>
                            )}
                        </Fragment>
                    ))}
                    {hidden.map((mid) => (
                        <div
                            className="provider-detail-model-row provider-detail-model-row--off"
                            key={mid}
                        >
                            <span className="provider-detail-model-id" title={mid}>
                                {mid}
                            </span>
                            <span className="provider-row-badge">
                                {t("settings.providerOriginHidden")}
                            </span>
                            <IconButton
                                size="sm"
                                aria-label={t("settings.providerModelRestore")}
                                title={t("settings.providerModelRestore")}
                                disabled={props.saving}
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
                    value={manualId}
                    placeholder={t("settings.providerModelAddPlaceholder")}
                    onChange={(e) => setManualId(e.target.value)}
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

            <FormField
                label={t("settings.providerTestTitle")}
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
                    busy={props.saving}
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
