/**
 * ProviderSection — provider cards for the Model tab. Every provider (built-in
 * or custom) renders as one clickable card: name + status dot, then a meta
 * line (customs show a short protocol badge, all show the model count).
 * Clicking a card opens the shared ProviderDetailModal, which holds the API
 * key, custom-only fields, and the model list in one panel.
 *
 * After any save, refresh the providers list and model list via
 * `useProviders.refresh` + `onKeysChanged`.
 */
import type {
    CustomModelEntry,
    CustomProviderConfig,
    GlobalConfigPatch,
    ProviderView,
    WorkspaceId,
} from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { useProviders } from "../../hooks/useProviders.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { getGlobalConfig } from "../../lib/globalConfig.ts";
import { Tag } from "../ui/Tag.tsx";
import { ProviderDetailModal } from "./ProviderDetailModal.tsx";

export interface ProviderSectionProps {
    client: TacoClient;
    /** Current workspace — providers.list requires it; not rendered until a workspace is ensured. */
    workspace: WorkspaceId | null;
    /** Notify the parent to refetch the model list after a key / custom-provider save. */
    onKeysChanged?: () => void;
}

type Detail =
    | { kind: "builtin"; provider: ProviderView }
    | { kind: "custom"; provider: ProviderView; cfg: CustomProviderConfig }
    | { kind: "add" }
    | null;

export function ProviderSection(props: ProviderSectionProps) {
    const { t } = useT();
    const { providers, refresh } = useProviders(props.client, props.workspace);
    const { save, saving, error } = useSaveConfigPatch(props.client);
    const globalState = useGlobalConfig();
    const [detail, setDetail] = useState<Detail>(null);

    // Masked key for a provider — the sidecar view already masks
    // (`sk-ant-…AbCd`), so plaintext never reaches the client. Writes land in
    // `apiKeys[id]`; the dedicated anthropic/openai view fields cover configs
    // written before this unified path.
    const maskFor = (id: string): string | undefined => {
        const view = globalState.global;
        const fromMap = view.apiKeys?.[id]?.mask;
        if (fromMap) return fromMap;
        if (id === "anthropic") return view.anthropicApiKey?.mask;
        if (id === "openai") return view.openaiApiKey?.mask;
        return undefined;
    };
    /** Full customProviders list — read from globalConfig (needed for settings.write patch). */
    const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>(
        () => getGlobalConfig().global.customProviders ?? [],
    );

    // Sync local cache after globalConfig changes. Depends on globalState
    // (NOT providers): the builtin list is the same and the relevant edit is
    // a custom provider add/delete/edit, which only moves globalState.
    useEffect(() => {
        setCustomProviders(globalState.global.customProviders ?? []);
    }, [globalState.global]);

    if (!props.workspace) return null;
    const workspace = props.workspace;

    const saveBuiltin = async (
        providerId: string,
        apiKey: string | undefined,
        extras: CustomModelEntry[],
        hidden: string[],
    ): Promise<void> => {
        const patch: {
            apiKeys?: Record<string, string>;
            providerExtraModels?: Record<string, CustomModelEntry[]>;
            providerHiddenModels?: Record<string, string[]>;
        } = {};
        if (apiKey) patch.apiKeys = { [providerId]: apiKey };
        // Both maps are whole-object replaces on the server. Merge this
        // provider's entry into the current map, dropping the key when its
        // list empties (the validator rejects empty arrays). Extras and hides
        // travel in one write so the registry applies them together.
        const extrasNow = { ...(getGlobalConfig().global.providerExtraModels ?? {}) };
        if (extras.length > 0) extrasNow[providerId] = extras;
        else delete extrasNow[providerId];
        const hiddenNow = { ...(getGlobalConfig().global.providerHiddenModels ?? {}) };
        if (hidden.length > 0) hiddenNow[providerId] = hidden;
        else delete hiddenNow[providerId];
        const currentExtras = getGlobalConfig().global.providerExtraModels ?? {};
        const currentHidden = getGlobalConfig().global.providerHiddenModels ?? {};
        if (JSON.stringify(extrasNow) !== JSON.stringify(currentExtras)) {
            patch.providerExtraModels = extrasNow;
        }
        if (JSON.stringify(hiddenNow) !== JSON.stringify(currentHidden)) {
            patch.providerHiddenModels = hiddenNow;
        }
        if (Object.keys(patch).length === 0) return;
        await save({ kind: "global", patch });
        refresh();
        props.onKeysChanged?.();
    };

    const saveCustom = async (cfg: CustomProviderConfig, apiKey: string): Promise<void> => {
        // Read from getGlobalConfig() — the useState closure can go stale between
        // two rapid submits, and the server is always authoritative.
        const current = getGlobalConfig().global.customProviders ?? [];
        const next = current.some((c) => c.id === cfg.id)
            ? current.map((c) => (c.id === cfg.id ? cfg : c))
            : [...current, cfg];
        const patch: {
            customProviders: CustomProviderConfig[];
            apiKeys?: Record<string, string>;
        } = { customProviders: next };
        if (apiKey) patch.apiKeys = { [cfg.id]: apiKey };
        await save({ kind: "global", patch });
        refresh();
        props.onKeysChanged?.();
    };

    const deleteCustom = async (id: string): Promise<void> => {
        const current = getGlobalConfig().global.customProviders ?? [];
        const rest = current.filter((c) => c.id !== id);
        const patch: GlobalConfigPatch = {
            customProviders: rest,
            apiKeys: { [id]: "" },
        };
        // A defaultProvider naming a deleted provider resolves to nothing —
        // every later session.create fails with "no model configured", and no
        // catalog entry can ever bring that id back. Drop the stale qualifier
        // and keep defaultModel: the lookup then falls back to a cross-provider
        // search by id, which succeeds when the user added that model elsewhere
        // (the usual reason they delete a relay in favour of a built-in).
        // `null`, not `undefined`: the patch crosses a JSON-RPC frame, and
        // JSON.stringify drops an undefined-valued key — the clear would
        // silently no-op. `saveGlobalConfig` treats null as clear.
        if (getGlobalConfig().global.defaultProvider === id) {
            patch.defaultProvider = null;
        }
        await save({ kind: "global", patch });
        refresh();
        props.onKeysChanged?.();
    };

    return (
        <section className="settings-tab-subsection">
            <div className="provider-section-head">
                <h3>{t("settings.providersTitle")}</h3>
                <button
                    type="button"
                    className="prompt-button"
                    disabled={saving}
                    onClick={() => setDetail({ kind: "add" })}
                >
                    {t("settings.customProviderAddBtn")}
                </button>
            </div>
            <p className="settings-tab-desc">{t("settings.providersDesc")}</p>
            <div className="provider-list">
                {providers.map((p) => {
                    const cfg = p.custom
                        ? (customProviders.find((c) => c.id === p.id) ?? {
                              id: p.id,
                              name: p.name,
                              api: "chatcomplete" as const,
                              baseUrl: "",
                              models: [],
                          })
                        : undefined;
                    return (
                        <button
                            key={p.id}
                            type="button"
                            className="provider-row"
                            disabled={saving}
                            aria-label={`${p.name} — ${
                                p.configured
                                    ? t("settings.providerConfigured")
                                    : t("settings.providerNotConfigured")
                            }`}
                            onClick={() =>
                                setDetail(
                                    p.custom && cfg
                                        ? { kind: "custom", provider: p, cfg }
                                        : { kind: "builtin", provider: p },
                                )
                            }
                        >
                            <span className="provider-row-title">
                                <span
                                    className={`provider-row-dot${
                                        p.configured ? " provider-row-dot--ok" : ""
                                    }`}
                                    aria-hidden="true"
                                />
                                <span className="provider-row-name">{p.name}</span>
                            </span>
                            <span className="provider-row-meta">
                                <span className="provider-row-count">
                                    {t("settings.providerModelCount", {
                                        // Hidden statics ride along in the view for restore,
                                        // but they are not selectable — don't count them.
                                        count: p.models.filter((m) => m.origin !== "hidden").length,
                                    })}
                                </span>
                                {p.custom && cfg && (
                                    <Tag className="provider-row-badge">
                                        {t("settings.customBadge")} ·{" "}
                                        {t(`settings.providerApiShort_${cfg.api}`)}
                                    </Tag>
                                )}
                            </span>
                        </button>
                    );
                })}
            </div>
            {detail !== null && (
                <ProviderDetailModal
                    client={props.client}
                    workspace={workspace}
                    provider={detail.kind === "add" ? undefined : detail.provider}
                    cfg={detail.kind === "custom" ? detail.cfg : undefined}
                    existingIds={customProviders.map((c) => c.id)}
                    mask={detail.kind === "add" ? undefined : maskFor(detail.provider.id)}
                    defaultProvider={globalState.global.defaultProvider}
                    saving={saving}
                    saveError={error}
                    onSaveBuiltin={
                        detail.kind === "builtin"
                            ? async (apiKey, extras, hidden) => {
                                  await saveBuiltin(detail.provider.id, apiKey, extras, hidden);
                                  setDetail(null);
                              }
                            : undefined
                    }
                    onSaveCustom={
                        detail.kind !== "builtin"
                            ? async (cfg, apiKey) => {
                                  await saveCustom(cfg, apiKey);
                                  setDetail(null);
                              }
                            : undefined
                    }
                    onDeleteCustom={
                        detail.kind === "custom"
                            ? async () => {
                                  await deleteCustom(detail.cfg.id);
                                  setDetail(null);
                              }
                            : undefined
                    }
                    onClose={() => setDetail(null)}
                />
            )}
            {detail === null && error && (
                <div className="error-banner" role="alert">
                    {error}
                </div>
            )}
        </section>
    );
}
