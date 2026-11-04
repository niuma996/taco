/**
 * ModelTab — Settings drawer "Model" tab: default model and thinking level.
 *
 * Both are global config; writes go through `client.settingsWrite({ global: patch })`.
 * Subscribes to `globalConfig.ts`; useSaveConfigPatch emits immediately on RPC success
 * without waiting for the next loadGlobalConfig. Per-session overrides live in the chat input.
 */
import type { ThinkingLevel, WorkspaceId } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import {
    defaultModelForNewSession,
    type GlobalConfigState,
    getGlobalConfig,
    subscribeGlobalConfig,
} from "../../lib/globalConfig.ts";
import { Select } from "../ui/Select.tsx";
import { ModelMenu } from "./ModelMenu";
import type { ModelOption, ModelSelection } from "./ModelPicker";
import { ProviderSection } from "./ProviderSection";
import { ThinkingSlider } from "./ThinkingSlider";

export interface ModelTabProps {
    options: ModelOption[];
    client: TacoClient;
    /** Current workspace — providers.list requires it; the providers section is hidden when null. */
    workspace: WorkspaceId | null;
    /** Force-refetch the model list when the user opens the picker or changes a key. */
    onRefreshModels?: () => void;
}

export function ModelTab(props: ModelTabProps) {
    const [state, setState] = useState<GlobalConfigState>(() => getGlobalConfig());
    const { t } = useT();

    useEffect(() => subscribeGlobalConfig(setState), []);

    const defaultModel = defaultModelForNewSession(state.global);
    const defaultOption: ModelOption | undefined = defaultModel
        ? (props.options.find(
              (o) =>
                  o.id === defaultModel.id &&
                  (defaultModel.provider === "" || o.provider === defaultModel.provider),
          ) ?? { provider: defaultModel.provider, id: defaultModel.id })
        : undefined;
    const selection: ModelSelection | undefined = defaultOption
        ? { provider: defaultOption.provider, id: defaultOption.id }
        : undefined;

    // Both model and thinking level live in global config but use separate
    // useSaveConfigPatch instances so their saving/error states don't collide
    // (e.g. one section disabling both inputs simultaneously).
    const { save: saveModel, saving, error } = useSaveConfigPatch(props.client);
    const onSetDefault = (next: ModelSelection) =>
        // settings.write accepts id-only (when provider is missing, the backend's
        // findModelById searches across providers); normalize the empty provider away.
        void saveModel({
            kind: "global",
            patch: { defaultModel: next.id, defaultProvider: next.provider || undefined },
        });

    const {
        save: saveThinking,
        saving: savingThinking,
        error: thinkingError,
    } = useSaveConfigPatch(props.client);
    const currentThinking: ThinkingLevel = state.global.thinkingLevel ?? "off";
    const onSetThinking = (next: ThinkingLevel) =>
        void saveThinking({ kind: "global", patch: { thinkingLevel: next } });

    // A sentinel stands in for "no lite model configured": Radix Select forbids
    // an empty item value, and `""` on the Root means "no selection". `provider/id`
    // matches the resolver's slash form.
    const NO_LITE_MODEL = "none";
    const {
        save: saveLite,
        saving: savingLite,
        error: liteError,
    } = useSaveConfigPatch(props.client);
    const configuredLite = state.global.liteModel;
    const liteOption =
        props.options.find((o) => `${o.provider}/${o.id}` === configuredLite) ??
        props.options.find((o) => o.id === configuredLite);
    const liteValue = liteOption
        ? `${liteOption.provider}/${liteOption.id}`
        : (configuredLite ?? NO_LITE_MODEL);
    const liteOptions = [
        { value: NO_LITE_MODEL, label: t("settings.liteModelNone") },
        ...props.options.map((o) => ({
            value: `${o.provider}/${o.id}`,
            label: o.name ? `${o.name} (${o.provider})` : `${o.id} (${o.provider})`,
        })),
    ];
    if (!liteOptions.some((o) => o.value === liteValue) && liteValue !== "") {
        liteOptions.push({ value: liteValue, label: liteValue });
    }
    const onSetLite = (next: string) =>
        void saveLite({
            kind: "global",
            patch: { liteModel: next === NO_LITE_MODEL ? null : next },
        });

    return (
        <section className="settings-tab">
            <h3>{t("settings.tabModel")}</h3>

            {/* Section ① Providers — list all built-in providers, fill keys inline. */}
            <ProviderSection
                client={props.client}
                workspace={props.workspace}
                onKeysChanged={props.onRefreshModels}
            />

            {/* Section ② Default model — list models from all configured providers. */}
            <h3 className="settings-tab-h3-secondary">{t("settings.defaultModelTitle")}</h3>
            <p className="settings-tab-desc">{t("settings.defaultModelDesc")}</p>
            {props.options.length > 0 ? (
                <>
                    <div className="settings-row">
                        <ModelMenu
                            value={selection}
                            options={props.options}
                            onModelChange={onSetDefault}
                            disabled={saving}
                            onOpen={props.onRefreshModels}
                            placement="down"
                        />
                        {saving && <span className="settings-saving">{t("app.saving")}</span>}
                    </div>
                    {error && (
                        <div className="error-banner" role="alert">
                            {error}
                        </div>
                    )}
                </>
            ) : (
                <p className="settings-tab-desc">{t("settings.providerFirst")}</p>
            )}

            <h3 className="settings-tab-h3-secondary">{t("settings.liteModelTitle")}</h3>
            <p className="settings-tab-desc">{t("settings.liteModelDesc")}</p>
            <div className="settings-row">
                <Select
                    value={liteValue}
                    options={liteOptions}
                    onValueChange={onSetLite}
                    disabled={savingLite}
                    label={t("settings.liteModelTitle")}
                />
                {savingLite && <span className="settings-saving">{t("app.saving")}</span>}
            </div>
            {liteError && (
                <div className="error-banner" role="alert">
                    {liteError}
                </div>
            )}

            <h3 className="settings-tab-h3-secondary">{t("settings.defaultThinkingLevel")}</h3>
            <p className="settings-tab-desc">{t("settings.defaultThinkingDesc")}</p>
            <div className="settings-row-block">
                <ThinkingSlider
                    value={currentThinking}
                    onChange={onSetThinking}
                    disabled={savingThinking}
                />
                {savingThinking && <span className="settings-saving">{t("app.saving")}</span>}
            </div>
            {thinkingError && (
                <div className="error-banner" role="alert">
                    {thinkingError}
                </div>
            )}
        </section>
    );
}
