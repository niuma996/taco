import { useState } from "react";
import { useGlobalConfig } from "../hooks/primitives/useGlobalConfig";
import { useSaveConfigPatch } from "../hooks/primitives/useSaveConfigPatch";
import { useT } from "../i18n/useI18n";
import type { TacoClient } from "../lib/clients/tacoClient";
import { Select } from "./ui/Select";

/** Changes the shared shell approval mode from the composer. */
export function CommandPermissionModeSelector({ client }: { client: TacoClient }) {
    const { global, loaded } = useGlobalConfig();
    const { save, saving, error } = useSaveConfigPatch(client);
    const { t } = useT();
    const [reading, setReading] = useState(false);
    const [readError, setReadError] = useState<string | null>(null);
    const config = global.commandPermissions;
    const mode = config?.mode === "auto" ? "auto" : "ask";

    async function changeMode(next: "ask" | "auto") {
        setReading(true);
        setReadError(null);
        try {
            await save({
                kind: "global",
                patch: {
                    commandPermissionsEdit: { mode: next },
                },
            });
        } catch (failure) {
            setReadError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setReading(false);
        }
    }

    return (
        <div className="input-permission-mode" title={t("input.commandPermissionModeHint")}>
            <Select
                value={mode}
                disabled={!loaded || saving || reading}
                label={t("settings.permissionsMode")}
                options={[
                    { value: "ask", label: t("settings.permissionsAsk") },
                    { value: "auto", label: t("settings.permissionsAuto") },
                ]}
                onValueChange={(next) => {
                    if (next !== "ask" && next !== "auto") return;
                    void changeMode(next);
                }}
            />
            {(readError || error) && (
                <span className="permission-error" role="alert">
                    {readError || error}
                </span>
            )}
        </div>
    );
}
