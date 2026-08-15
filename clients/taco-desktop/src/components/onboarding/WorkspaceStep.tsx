import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useT } from "../../i18n/useI18n.js";
import { isValidWorkspaceCwd } from "../../lib/workspaceStorage.js";
import { Button } from "../ui/Button.tsx";

export interface WorkspaceStepProps {
    defaultCwd: string;
    /**
     * Sync the picked/confirmed cwd up to the parent so footer Next and the
     * wizard's `workspaceCwd` both point at the right path. Does NOT
     * advance — the user clicks Next in the wizard footer to commit.
     */
    onChange: (cwd: string) => void;
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
            // Sync the picked path up so footer Next opens the right cwd.
            // No auto-advance — the user clicks Next to commit.
            props.onChange(selected);
        }
    };

    const confirm = () => {
        if (!isValidWorkspaceCwd(cwd)) {
            setError(t("onboarding.workspaceInvalid"));
            return;
        }
        // Same as Choose other: sync only, footer Next advances.
        props.onChange(cwd);
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
