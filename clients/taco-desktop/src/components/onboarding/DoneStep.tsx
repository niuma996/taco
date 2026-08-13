import { useT } from "../../i18n/useI18n.js";
import type { ModelSelection } from "../settings/ModelPicker.js";

export interface DoneStepProps {
    workspace: string;
    providerCount: number;
    model: ModelSelection | undefined;
    onFinish: () => void;
}

export function DoneStep(props: DoneStepProps) {
    const { t } = useT();
    return (
        <div className="onboarding-step">
            <h2>{t("onboarding.doneTitle")}</h2>
            <p>{t("onboarding.doneBody")}</p>
            <ul className="onboarding-summary">
                <li>
                    <span>{t("onboarding.doneWorkspace")}</span>
                    <span>{props.workspace}</span>
                </li>
                <li>
                    <span>{t("onboarding.doneProvider")}</span>
                    <span>{props.providerCount}</span>
                </li>
                <li>
                    <span>{t("onboarding.doneModel")}</span>
                    <span>{props.model ? props.model.id : "—"}</span>
                </li>
            </ul>
            <button type="button" className="onboarding-done-cta" onClick={props.onFinish}>
                {t("onboarding.openTaco")}
            </button>
        </div>
    );
}
