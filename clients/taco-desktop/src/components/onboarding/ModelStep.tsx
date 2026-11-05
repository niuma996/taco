import type { GlobalConfigPatch, ThinkingLevel, WorkspaceId } from "@taco-ai/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { useStableCallback } from "../../hooks/primitives/useStableCallback.ts";
import { useProviders } from "../../hooks/useProviders.js";
import { useWorkspaceModels } from "../../hooks/useWorkspaceModels.js";
import { useT } from "../../i18n/useI18n.js";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { defaultModelForNewSession } from "../../lib/globalConfig.ts";
import { ModelMenu } from "../settings/ModelMenu.js";
import type { ModelOption, ModelSelection } from "../settings/ModelPicker.js";
import { ThinkingSlider } from "../settings/ThinkingSlider.tsx";

export interface ModelStepProps {
    client: TacoClient;
    workspace: WorkspaceId;
    onSelect: (selection: ModelSelection | undefined) => void;
    onSavingChange?: (saving: boolean) => void;
}

export function ModelStep(props: ModelStepProps) {
    const { t } = useT();
    const { options, refresh: refreshModels } = useWorkspaceModels(props.client, props.workspace);
    const { providers, refresh: refreshProviders } = useProviders(props.client, props.workspace);
    const { save, error } = useSaveConfigPatch(props.client);
    const [writeState, setWriteState] = useState({ pending: false, failed: false });
    const saving = writeState.pending;
    const { global } = useGlobalConfig();
    const notifySelection = useStableCallback(props.onSelect);
    const notifySaving = useStableCallback((busy: boolean) => props.onSavingChange?.(busy));

    // Mirror App.tsx: only show models from providers that actually have a configured key.
    // Without this filter, sidecar returns every model's full id+provider pair, including
    // ones whose key is missing — onboarding would offer models the user can't use.
    const configuredProviderIds = useMemo(
        () => new Set(providers.filter((p) => p.configured).map((p) => p.id)),
        [providers],
    );
    const filteredOptions = useMemo(
        () => options.filter((o) => configuredProviderIds.has(o.provider)),
        [options, configuredProviderIds],
    );

    // First transition empty → non-empty triggers a model refresh, matching App.tsx's
    // timing fix — otherwise listModels may resolve before providers on cold start.
    const hadConfiguredRef = useRef(false);
    useEffect(() => {
        const hasConfigured = configuredProviderIds.size > 0;
        if (hasConfigured && !hadConfiguredRef.current) {
            hadConfiguredRef.current = true;
            refreshModels();
        }
    }, [configuredProviderIds, refreshModels]);

    const value = useMemo<ModelOption | undefined>(() => {
        const selected = defaultModelForNewSession(global);
        if (!selected) return undefined;
        return filteredOptions.find(
            (o) => o.id === selected.id && (!selected.provider || o.provider === selected.provider),
        );
    }, [global, filteredOptions]);

    useEffect(() => {
        notifySelection(
            writeState.pending || writeState.failed || !value
                ? undefined
                : { provider: value.provider, id: value.id },
        );
    }, [value, writeState, notifySelection]);

    const savePatch = (patch: GlobalConfigPatch) => {
        notifySelection(undefined);
        notifySaving(true);
        setWriteState({ pending: true, failed: false });
        void save({ kind: "global", patch })
            .then(
                () => setWriteState({ pending: false, failed: false }),
                () => setWriteState({ pending: false, failed: true }),
            )
            .finally(() => notifySaving(false));
    };

    const handleChange = (next: ModelSelection) => {
        if (!configuredProviderIds.has(next.provider)) return;
        savePatch({ defaultModel: next.id, defaultProvider: next.provider || null });
    };

    const handleThinkingChange = (next: ThinkingLevel) => {
        savePatch({ thinkingLevel: next });
    };

    const refresh = () => {
        refreshModels();
        refreshProviders();
    };

    return (
        <div className="onboarding-step">
            <h2>{t("onboarding.modelTitle")}</h2>
            <p>{t("onboarding.modelBody")}</p>
            {filteredOptions.length > 0 ? (
                <fieldset
                    className="model-config-card"
                    aria-label={t("settings.defaultModelTitle")}
                >
                    <div className="settings-row">
                        <ModelMenu
                            value={value ? { provider: value.provider, id: value.id } : undefined}
                            options={filteredOptions}
                            onModelChange={handleChange}
                            disabled={saving}
                            onOpen={refresh}
                            placement="down"
                        />
                        {saving && <span className="settings-saving">{t("app.saving")}</span>}
                    </div>
                    {value && (
                        <div className="model-config-thinking">
                            <h4>{t("settings.defaultThinkingLevel")}</h4>
                            <p className="settings-tab-desc">{t("settings.defaultThinkingDesc")}</p>
                            <ThinkingSlider
                                value={global.thinkingLevel ?? "off"}
                                onChange={handleThinkingChange}
                                disabled={saving}
                            />
                        </div>
                    )}
                </fieldset>
            ) : (
                <p className="settings-tab-desc">{t("settings.providerFirst")}</p>
            )}
            {error && (
                <div className="error-banner" role="alert">
                    {error}
                </div>
            )}
            {!value && filteredOptions.length > 0 && (
                <div className="error-banner" role="status">
                    {t("onboarding.modelRequired")}
                </div>
            )}
        </div>
    );
}
