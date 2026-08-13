/**
 * ProviderSection — provider list and key management for the Model tab.
 *
 * Built-in providers: fill API keys. Custom providers: add/edit/delete via
 * `settings.write({ customProviders: full set })`. After any save, refresh
 * the providers list and model list via `useProviders.refresh`.
 */
import type { CustomProviderConfig, ProviderView, WorkspaceId } from "@taco-ai/protocol";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useGlobalConfig } from "../../hooks/useGlobalConfig.ts";
import { useProviders } from "../../hooks/useProviders.ts";
import { useSaveConfigPatch } from "../../hooks/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import { getGlobalConfig } from "../../lib/globalConfig.ts";
import type { TacoClient } from "../../lib/tacoClientTauri.ts";
import { CustomProviderForm } from "./CustomProviderForm.tsx";
import { ProviderKeyDialog } from "./ProviderKeyDialog.tsx";

export interface ProviderSectionProps {
    client: TacoClient;
    /** Current workspace — providers.list requires it; not rendered until a workspace is ensured. */
    workspace: WorkspaceId | null;
    /** Notify the parent to refetch the model list after a key / custom-provider save. */
    onKeysChanged?: () => void;
}

type Panel = { kind: "list" } | { kind: "add" } | { kind: "edit"; provider: CustomProviderConfig };

export function ProviderSection(props: ProviderSectionProps) {
    const { t } = useT();
    const { providers, refresh } = useProviders(props.client, props.workspace);
    const { save, saving, error } = useSaveConfigPatch(props.client);
    const globalState = useGlobalConfig();
    const [panel, setPanel] = useState<Panel>({ kind: "list" });

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

    // Sync local cache after useProviders refresh. Use getGlobalConfig() as the single
    // source of truth — shallow comparison by id would leave stale baseUrl/models after
    // editing non-id fields of an existing custom provider.
    // biome-ignore lint/correctness/useExhaustiveDependencies: providers ref is stable
    useEffect(() => {
        setCustomProviders(getGlobalConfig().global.customProviders ?? []);
    }, [providers]);

    if (!props.workspace) return null;

    const existingIds = customProviders.map((c) => c.id);

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
        setPanel({ kind: "list" });
    };

    const deleteCustom = async (id: string): Promise<void> => {
        // Read latest from getGlobalConfig(), not the closure's `customProviders`.
        const current = getGlobalConfig().global.customProviders ?? [];
        const rest = current.filter((c) => c.id !== id);
        await save({
            kind: "global",
            patch: {
                customProviders: rest,
                apiKeys: { [id]: "" },
            },
        });
        refresh();
        props.onKeysChanged?.();
        setPanel({ kind: "list" });
    };

    return (
        <section className="settings-tab-subsection">
            <div className="provider-section-head">
                <h3>{t("settings.providersTitle")}</h3>
                {panel.kind === "list" && (
                    <button
                        type="button"
                        className="prompt-button"
                        disabled={saving}
                        onClick={() => setPanel({ kind: "add" })}
                    >
                        {t("settings.customProviderAddBtn")}
                    </button>
                )}
            </div>
            <p className="settings-tab-desc">{t("settings.providersDesc")}</p>
            <div className="provider-list">
                {providers.map((p) =>
                    p.custom ? (
                        <CustomProviderRow
                            key={p.id}
                            provider={p}
                            cfg={
                                customProviders.find((c) => c.id === p.id) ?? {
                                    id: p.id,
                                    name: p.name,
                                    api: "chatcomplete",
                                    baseUrl: "",
                                    models: [],
                                }
                            }
                            disabled={saving}
                            mask={maskFor(p.id)}
                            onEdit={() => {
                                const cfg = customProviders.find((c) => c.id === p.id);
                                if (cfg) setPanel({ kind: "edit", provider: cfg });
                            }}
                            onDelete={() => void deleteCustom(p.id)}
                            onReplaceKey={async (key) => {
                                await save({
                                    kind: "global",
                                    patch: { apiKeys: { [p.id]: key } },
                                });
                                refresh();
                                props.onKeysChanged?.();
                            }}
                        />
                    ) : (
                        <ProviderRow
                            key={p.id}
                            provider={p}
                            disabled={saving}
                            mask={maskFor(p.id)}
                            onSaveKey={async (key) => {
                                await save({
                                    kind: "global",
                                    patch: { apiKeys: { [p.id]: key } },
                                });
                                refresh();
                                props.onKeysChanged?.();
                            }}
                        />
                    ),
                )}
            </div>
            {panel.kind === "add" && (
                <CustomProviderForm
                    existingIds={existingIds}
                    client={props.client}
                    onSave={(cfg, apiKey) => void saveCustom(cfg, apiKey)}
                    onCancel={() => setPanel({ kind: "list" })}
                />
            )}
            {panel.kind === "edit" && (
                <CustomProviderForm
                    existing={panel.provider}
                    existingIds={existingIds}
                    client={props.client}
                    onSave={(cfg, apiKey) => void saveCustom(cfg, apiKey)}
                    onCancel={() => setPanel({ kind: "list" })}
                />
            )}
            {error && <div className="error-banner">{error}</div>}
        </section>
    );
}

interface ProviderRowProps {
    provider: ProviderView;
    disabled: boolean;
    /** Masked key from the sidecar view (e.g. `sk-ant-…AbCd`); undefined when not configured. */
    mask?: string;
    onSaveKey: (key: string) => Promise<void>;
}

function ProviderRow(props: ProviderRowProps) {
    const { t } = useT();
    const [dialogOpen, setDialogOpen] = useState(false);
    const { provider } = props;

    return (
        <div className="provider-row">
            <div className="provider-row-head">
                <div className="provider-row-info">
                    <span className="provider-row-name">{provider.name}</span>
                    <span
                        className={`provider-row-status${
                            provider.configured ? " provider-row-status--ok" : ""
                        }`}
                    >
                        {provider.configured
                            ? t("settings.providerConfigured")
                            : t("settings.providerNotConfigured")}
                    </span>
                </div>
                <div className="provider-row-actions">
                    <button
                        type="button"
                        className="icon-button provider-row-icon provider-row-key"
                        disabled={props.disabled}
                        title={
                            provider.configured
                                ? t("settings.providerReplaceKey")
                                : t("settings.providerSetKey")
                        }
                        aria-label={
                            provider.configured
                                ? t("settings.providerReplaceKey")
                                : t("settings.providerSetKey")
                        }
                        onClick={() => setDialogOpen(true)}
                    >
                        <KeyRound size={16} aria-hidden="true" />
                    </button>
                </div>
            </div>
            {dialogOpen && (
                <ProviderKeyDialog
                    providerName={provider.name}
                    configured={provider.configured}
                    currentMask={props.mask}
                    onSave={async (key) => {
                        await props.onSaveKey(key);
                        setDialogOpen(false);
                    }}
                    onCancel={() => setDialogOpen(false)}
                />
            )}
        </div>
    );
}

interface CustomProviderRowProps {
    provider: ProviderView;
    cfg: CustomProviderConfig;
    disabled: boolean;
    /** Masked key from the sidecar view (e.g. `sk-ant-…AbCd`); undefined when not configured. */
    mask?: string;
    onEdit: () => void;
    onDelete: () => void;
    onReplaceKey: (key: string) => Promise<void>;
}

function CustomProviderRow(props: CustomProviderRowProps) {
    const { t } = useT();
    const [dialogOpen, setDialogOpen] = useState(false);
    const { provider, cfg } = props;

    return (
        <div className="provider-row">
            <div className="provider-row-head">
                <div className="provider-row-info">
                    <span className="provider-row-name">{provider.name}</span>
                    <span className="provider-row-meta">
                        <span className="provider-row-badge">{t("settings.customBadge")}</span>{" "}
                        {t(`settings.customProviderApi_${cfg.api}`)}
                    </span>
                    <span
                        className={`provider-row-status${
                            provider.configured ? " provider-row-status--ok" : ""
                        }`}
                    >
                        {provider.configured
                            ? t("settings.providerConfigured")
                            : t("settings.providerNotConfigured")}
                    </span>
                </div>
                <div className="provider-row-actions">
                    <button
                        type="button"
                        className="icon-button provider-row-icon provider-row-key"
                        disabled={props.disabled}
                        title={
                            provider.configured
                                ? t("settings.providerReplaceKey")
                                : t("settings.providerSetKey")
                        }
                        aria-label={
                            provider.configured
                                ? t("settings.providerReplaceKey")
                                : t("settings.providerSetKey")
                        }
                        onClick={() => setDialogOpen(true)}
                    >
                        <KeyRound size={16} aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        className="icon-button provider-row-icon"
                        disabled={props.disabled}
                        title={t("settings.customProviderEditBtn")}
                        aria-label={t("settings.customProviderEditBtn")}
                        onClick={props.onEdit}
                    >
                        <Pencil size={16} aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        className="icon-button provider-row-icon provider-row-delete"
                        disabled={props.disabled}
                        title={t("settings.customProviderDeleteBtn")}
                        aria-label={t("settings.customProviderDeleteBtn")}
                        onClick={props.onDelete}
                    >
                        <Trash2 size={16} aria-hidden="true" />
                    </button>
                </div>
            </div>
            {dialogOpen && (
                <ProviderKeyDialog
                    providerName={provider.name}
                    configured={provider.configured}
                    currentMask={props.mask}
                    onSave={async (key) => {
                        await props.onReplaceKey(key);
                        setDialogOpen(false);
                    }}
                    onCancel={() => setDialogOpen(false)}
                />
            )}
        </div>
    );
}
