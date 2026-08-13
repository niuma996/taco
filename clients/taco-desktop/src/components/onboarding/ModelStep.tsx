import type { WorkspaceId } from "@taco-ai/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProviders } from "../../hooks/useProviders.js";
import { useSaveConfigPatch } from "../../hooks/useSaveConfigPatch.js";
import { useWorkspaceModels } from "../../hooks/useWorkspaceModels.js";
import { useT } from "../../i18n/useI18n.js";
import type { TacoClient } from "../../lib/tacoClientTauri.ts";
import { ModelMenu } from "../settings/ModelMenu.js";
import type { ModelOption, ModelSelection } from "../settings/ModelPicker.js";

export interface ModelStepProps {
    client: TacoClient;
    workspace: WorkspaceId;
    onSelect: (selection: ModelSelection) => void;
}

export function ModelStep(props: ModelStepProps) {
    const { t } = useT();
    const { options, refresh: refreshModels } = useWorkspaceModels(props.client, props.workspace);
    const { providers, refresh: refreshProviders } = useProviders(props.client, props.workspace);
    const { save, saving } = useSaveConfigPatch(props.client);
    const [selected, setSelected] = useState<ModelSelection | undefined>(undefined);

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
        if (!selected) return undefined;
        return filteredOptions.find(
            (o) => o.id === selected.id && o.provider === selected.provider,
        );
    }, [selected, filteredOptions]);

    const handleChange = (next: ModelSelection) => {
        setSelected(next);
        void save({
            kind: "global",
            patch: { defaultModel: next.id, defaultProvider: next.provider || undefined },
        }).then(() => {
            props.onSelect(next);
        });
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
            ) : (
                <p className="settings-tab-desc">{t("settings.providerFirst")}</p>
            )}
            {!selected && filteredOptions.length > 0 && (
                <div className="error-banner">{t("onboarding.modelRequired")}</div>
            )}
        </div>
    );
}
