import type { WorkspaceId } from "@taco-ai/protocol";
import { useEffect } from "react";
import { useProviders } from "../../hooks/useProviders.js";
import { useT } from "../../i18n/useI18n.js";
import type { TacoClient } from "../../lib/tacoClientTauri.ts";
import { ProviderSection } from "../settings/ProviderSection.js";

export interface ProviderStepProps {
    client: TacoClient;
    workspace: WorkspaceId;
    onConfigured: () => void;
}

export function ProviderStep(props: ProviderStepProps) {
    const { t } = useT();
    const { providers, refresh } = useProviders(props.client, props.workspace);
    const configuredCount = providers.filter((p) => p.configured).length;

    useEffect(() => {
        if (configuredCount > 0) {
            props.onConfigured();
        }
    }, [configuredCount, props.onConfigured]);

    return (
        <div className="onboarding-step">
            <h2>{t("onboarding.providerTitle")}</h2>
            <p>{t("onboarding.providerBody")}</p>
            <ProviderSection
                client={props.client}
                workspace={props.workspace}
                onKeysChanged={refresh}
            />
            {configuredCount === 0 && (
                <div className="error-banner">{t("onboarding.providerRequired")}</div>
            )}
        </div>
    );
}
