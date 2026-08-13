import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.js";
import { isValidWorkspaceCwd } from "../../lib/workspaceStorage.js";
import { Button } from "../ui/Button.tsx";

export interface WorkspaceStepProps {
    defaultCwd: string;
    onConfirm: (cwd: string) => void;
}

export function WorkspaceStep(props: WorkspaceStepProps) {
    const { t } = useT();
    const [cwd, setCwd] = useState(props.defaultCwd);
    const [error, setError] = useState<string | null>(null);

    const chooseFolder = async () => {
        const selected = await openDialog({ directory: true });
        if (selected && !Array.isArray(selected)) {
            setCwd(selected);
            setError(null);
        }
    };

    const confirm = () => {
        if (!isValidWorkspaceCwd(cwd)) {
            setError(t("onboarding.workspaceInvalid"));
            return;
        }
        props.onConfirm(cwd);
    };

    return (
        <div className="onboarding-step">
            <h2>{t("onboarding.workspaceTitle")}</h2>
            <p>{t("onboarding.workspaceBody")}</p>
            <div className="settings-row-block">
                <span>{t("onboarding.workspaceDefaultPath")}</span>
                <input type="text" value={cwd} readOnly />
            </div>
            <div className="settings-row">
                <button type="button" className="onboarding-cta" onClick={confirm}>
                    {t("onboarding.workspaceUseDefault")}
                </button>
                <Button variant="ghost" onClick={chooseFolder}>
                    {t("onboarding.workspaceChooseOther")}
                </Button>
            </div>
            {error && <div className="error-banner">{error}</div>}
        </div>
    );
}
