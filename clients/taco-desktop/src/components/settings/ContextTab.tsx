/**
 * ContextTab — Settings "项目约定" tab.
 *
 * Toggle project-context instructions injection (CLAUDE.md / AGENTS.md /
 * DESIGN.md) and per-file enable switches. Writes go through the existing
 * `settings.write` RPC; the sidecar merges the patch per-leaf so a partial
 * patch flips only the named file (matches `compaction`'s merge semantics).
 * The UI still sends the full draft each time — simpler and consistent.
 */

import { useGlobalConfig } from "../../hooks/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { Switch } from "../ui/Switch.tsx";

export interface ContextTabProps {
    client: TacoClient;
}

interface DraftFiles {
    claudeMd: boolean;
    agentsMd: boolean;
    designMd: boolean;
}

interface DraftInstructions {
    enabled: boolean;
    files: DraftFiles;
    inheritToSubagents: boolean;
}

/** Default values when the user has not configured the field — mirrors the
 *  sidecar's `DEFAULT_INSTRUCTIONS_CONFIG` so the UI shows the documented
 *  defaults before any patch lands. */
const DEFAULT_DRAFT: DraftInstructions = {
    enabled: true,
    files: { claudeMd: true, agentsMd: true, designMd: false },
    inheritToSubagents: true,
};

function mergeDraft(view: unknown): DraftInstructions {
    // `state.global.instructions` may be undefined (file absent or never
    // patched). Treat as defaults rather than throwing — the UI should
    // always render, even if settings.write has never been called.
    if (!view || typeof view !== "object") return { ...DEFAULT_DRAFT };
    const v = view as Record<string, unknown>;
    const files = (v.files as Record<string, unknown> | undefined) ?? {};
    return {
        enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_DRAFT.enabled,
        files: {
            claudeMd:
                typeof files.claudeMd === "boolean" ? files.claudeMd : DEFAULT_DRAFT.files.claudeMd,
            agentsMd:
                typeof files.agentsMd === "boolean" ? files.agentsMd : DEFAULT_DRAFT.files.agentsMd,
            designMd:
                typeof files.designMd === "boolean" ? files.designMd : DEFAULT_DRAFT.files.designMd,
        },
        inheritToSubagents:
            typeof v.inheritToSubagents === "boolean"
                ? v.inheritToSubagents
                : DEFAULT_DRAFT.inheritToSubagents,
    };
}

export function ContextTab(props: ContextTabProps) {
    const state = useGlobalConfig();
    const { save, saving, error } = useSaveConfigPatch(props.client);
    const { t } = useT();

    const draft = mergeDraft(state.global.instructions);

    // Send the full draft each save — the sidecar's `mergeInstructionsPatch`
    // merges per-leaf, so unchanged inner flags keep their previous value.
    // Sending the whole draft is simpler than computing a minimal patch and
    // keeps the UI logic free of merge-awareness.
    const saveDraft = async (next: DraftInstructions): Promise<void> => {
        await save({ kind: "global", patch: { instructions: next } });
    };

    const updateAndSave = (
        patch: Partial<Omit<DraftInstructions, "files">> & { files?: Partial<DraftFiles> },
    ): void => {
        void saveDraft({ ...draft, ...patch, files: { ...draft.files, ...patch.files } });
    };

    return (
        <section className="settings-tab">
            <h3>{t("settings.contextTitle")}</h3>
            <p className="settings-tab-desc">{t("settings.contextDesc")}</p>
            <div className="settings-row compaction-toggle-row">
                <div className="compaction-toggle-text">
                    <span className="compaction-toggle-label">{t("settings.contextEnabled")}</span>
                    <span className="compaction-toggle-desc">
                        {t("settings.contextEnabledDesc")}
                    </span>
                </div>
                <Switch
                    checked={draft.enabled}
                    disabled={saving}
                    onChange={(next) => updateAndSave({ enabled: next })}
                    label={t("settings.contextEnabled")}
                />
            </div>
            <div className={`settings-row context-files${draft.enabled ? "" : " off"}`}>
                <fieldset className="context-files-fs" disabled={!draft.enabled || saving}>
                    <legend className="context-files-legend">
                        {t("settings.contextFilesLegend")}
                    </legend>
                    <div className="context-file-row">
                        <Switch
                            checked={draft.files.claudeMd}
                            disabled={!draft.enabled || saving}
                            onChange={(next) => updateAndSave({ files: { claudeMd: next } })}
                            label="CLAUDE.md"
                        />
                        <span className="context-file-label">CLAUDE.md</span>
                    </div>
                    <div className="context-file-row">
                        <Switch
                            checked={draft.files.agentsMd}
                            disabled={!draft.enabled || saving}
                            onChange={(next) => updateAndSave({ files: { agentsMd: next } })}
                            label="AGENTS.md"
                        />
                        <span className="context-file-label">AGENTS.md</span>
                    </div>
                    <div className="context-file-row">
                        <Switch
                            checked={draft.files.designMd}
                            disabled={!draft.enabled || saving}
                            onChange={(next) => updateAndSave({ files: { designMd: next } })}
                            label="DESIGN.md"
                        />
                        <span className="context-file-label">DESIGN.md</span>
                    </div>
                </fieldset>
            </div>
            <div className="settings-row compaction-toggle-row">
                <div className="compaction-toggle-text">
                    <span className="compaction-toggle-label">
                        {t("settings.contextInheritLabel")}
                    </span>
                    <span className="compaction-toggle-desc">
                        {t("settings.contextInheritDesc")}
                    </span>
                </div>
                <Switch
                    checked={draft.inheritToSubagents}
                    disabled={!draft.enabled || saving}
                    onChange={(next) => updateAndSave({ inheritToSubagents: next })}
                    label={t("settings.contextInheritLabel")}
                />
            </div>
            {error && <div className="error-banner">{error}</div>}
        </section>
    );
}
