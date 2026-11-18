/**
 * ModelTab — Settings drawer "Model" tab: default model and thinking level.
 *
 * Both are global config; writes go through `client.settingsWrite({ global: patch })`.
 * Subscribes to `globalConfig.ts`; useSaveConfigPatch emits immediately on RPC success
 * without waiting for the next loadGlobalConfig. Per-session overrides live in the chat input.
 */
import type { LiteThinkingLevel, ThinkingLevel, WorkspaceId } from "@taco-ai/protocol";
import { LITE_THINKING_LEVELS } from "@taco-ai/protocol";
import { useEffect, useRef, useState } from "react";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import {
    defaultModelForNewSession,
    type GlobalConfigState,
    getGlobalConfig,
    subscribeGlobalConfig,
} from "../../lib/globalConfig.ts";
import { TextInput } from "../ui/TextInput";
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

    const { save: saveModel, saving, error } = useSaveConfigPatch(props.client);
    const onSetDefault = (next: ModelSelection) =>
        // settings.write accepts id-only (when provider is missing, the backend's
        // findModelById searches across providers); normalize the empty provider away.
        void saveModel({
            kind: "global",
            patch: { defaultModel: next.id, defaultProvider: next.provider || null },
        }).catch(() => {});

    const {
        save: saveThinking,
        saving: savingThinking,
        error: thinkingError,
    } = useSaveConfigPatch(props.client);
    const currentThinking: ThinkingLevel = state.global.thinkingLevel ?? "off";
    const onSetThinking = (next: ThinkingLevel) =>
        void saveThinking({ kind: "global", patch: { thinkingLevel: next } }).catch(() => {});

    // The config stores `provider/id`; an id-only value is still accepted for
    // configs written before the provider was qualified.
    const {
        save: saveLite,
        saving: savingLite,
        error: liteError,
    } = useSaveConfigPatch(props.client);
    const configuredLite = state.global.liteModel;
    const liteOption =
        props.options.find((o) => `${o.provider}/${o.id}` === configuredLite) ??
        props.options.find((o) => o.id === configuredLite);
    // A configured model that is no longer in the catalog keeps its raw value as
    // the id, so the trigger still shows what is actually configured.
    const liteSelection: ModelSelection | undefined = liteOption
        ? { provider: liteOption.provider, id: liteOption.id }
        : configuredLite
          ? { provider: "", id: configuredLite }
          : undefined;
    const onSetLite = (next: ModelSelection) =>
        void saveLite({
            kind: "global",
            patch: { liteModel: `${next.provider}/${next.id}` },
        }).catch(() => {});
    const onClearLite = () =>
        void saveLite({ kind: "global", patch: { liteModel: null } }).catch(() => {});

    // An unset lite level follows the model; explicit off disables reasoning.
    const {
        save: saveLiteThinking,
        saving: savingLiteThinking,
        error: liteThinkingError,
    } = useSaveConfigPatch(props.client);
    const liteThinking: ThinkingLevel = state.global.liteThinkingLevel ?? "off";
    const onSetLiteThinking = (next: ThinkingLevel) => {
        // The slider only offers the low levels, so `next` is always one of
        // them; the guard keeps that a checked fact, not an assumption.
        if (!(LITE_THINKING_LEVELS as readonly string[]).includes(next)) return;
        void saveLiteThinking({
            kind: "global",
            patch: { liteThinkingLevel: next as LiteThinkingLevel },
        }).catch(() => {});
    };

    // The custom User-Agent is a free-text field, so it is committed on blur
    // or Enter rather than on every keystroke. `savedUserAgent` tracks what
    // the sidecar holds, so an external change (another window, a CLI edit)
    // replaces the draft without overwriting what the user is typing.
    const {
        save: saveUserAgent,
        saving: savingUserAgent,
        error: userAgentSaveError,
    } = useSaveConfigPatch(props.client);
    const savedUserAgent = state.global.userAgent ?? "";
    const [userAgentDraft, setUserAgentDraft] = useState(savedUserAgent);
    const [userAgentError, setUserAgentError] = useState<string | null>(null);
    const lastSyncedUserAgent = useRef(savedUserAgent);
    useEffect(() => {
        if (savedUserAgent === lastSyncedUserAgent.current) return;
        lastSyncedUserAgent.current = savedUserAgent;
        setUserAgentDraft(savedUserAgent);
    }, [savedUserAgent]);

    const commitUserAgent = () => {
        const next = userAgentDraft.trim();
        if (next === savedUserAgent) return;
        // The value lands in an HTTP header — reject anything that could
        // break out of it. The sidecar enforces the same rule.
        if (next.length > 256 || /[^\x20-\x7E]/.test(next)) {
            setUserAgentError(t("settings.userAgentInvalid"));
            return;
        }
        setUserAgentError(null);
        lastSyncedUserAgent.current = next;
        void saveUserAgent({
            kind: "global",
            patch: { userAgent: next === "" ? null : next },
        }).catch(() => {
            // Roll the draft back to what the sidecar still holds.
            lastSyncedUserAgent.current = savedUserAgent;
            setUserAgentDraft(savedUserAgent);
        });
    };

    return (
        <section className="settings-tab model-settings-tab">
            <h3>{t("settings.tabModel")}</h3>

            {/* Section ① Providers — list all built-in providers, fill keys inline. */}
            <ProviderSection client={props.client} workspace={props.workspace} />

            <fieldset className="model-config-card" aria-labelledby="main-model-title">
                <h3 id="main-model-title">{t("settings.defaultModelTitle")}</h3>
                <p className="settings-tab-desc">{t("settings.defaultModelDesc")}</p>
                {props.options.length > 0 || selection ? (
                    <div className="settings-row">
                        <ModelMenu
                            value={selection}
                            options={props.options}
                            onModelChange={onSetDefault}
                            disabled={saving || savingThinking}
                            onOpen={props.onRefreshModels}
                            placement="down"
                        />
                        {saving && <span className="settings-saving">{t("app.saving")}</span>}
                    </div>
                ) : (
                    <p className="settings-tab-desc">{t("settings.providerFirst")}</p>
                )}
                {error && (
                    <div className="error-banner" role="alert">
                        {error}
                    </div>
                )}
                {selection && (
                    <div className="model-config-thinking">
                        <h4>{t("settings.defaultThinkingLevel")}</h4>
                        <p className="settings-tab-desc">{t("settings.defaultThinkingDesc")}</p>
                        <ThinkingSlider
                            value={currentThinking}
                            onChange={onSetThinking}
                            disabled={saving || savingThinking}
                        />
                        {savingThinking && (
                            <span className="settings-saving">{t("app.saving")}</span>
                        )}
                        {thinkingError && (
                            <div className="error-banner" role="alert">
                                {thinkingError}
                            </div>
                        )}
                    </div>
                )}
            </fieldset>

            <fieldset className="model-config-card" aria-labelledby="lite-model-title">
                <h3 id="lite-model-title">{t("settings.liteModelTitle")}</h3>
                <p className="settings-tab-desc">{t("settings.liteModelDesc")}</p>
                <div className="settings-row">
                    <ModelMenu
                        value={liteSelection}
                        options={props.options}
                        onModelChange={onSetLite}
                        onClear={onClearLite}
                        clearLabel={t("settings.liteModelNone")}
                        disabled={savingLite || savingLiteThinking}
                        onOpen={props.onRefreshModels}
                        placement="down"
                    />
                    {savingLite && <span className="settings-saving">{t("app.saving")}</span>}
                </div>
                {liteError && (
                    <div className="error-banner" role="alert">
                        {liteError}
                    </div>
                )}
                {configuredLite && (
                    <div className="model-config-thinking">
                        <h4>{t("settings.liteThinkingLevelTitle")}</h4>
                        <p className="settings-tab-desc">{t("settings.liteThinkingLevelDesc")}</p>
                        <ThinkingSlider
                            value={liteThinking}
                            onChange={onSetLiteThinking}
                            disabled={savingLite || savingLiteThinking}
                            levels={LITE_THINKING_LEVELS}
                            ariaLabel={t("settings.liteThinkingLevelTitle")}
                            modelDefault={{
                                selected: state.global.liteThinkingLevel === undefined,
                                onSelect: () => {
                                    void saveLiteThinking({
                                        kind: "global",
                                        patch: { liteThinkingLevel: null },
                                    }).catch(() => {});
                                },
                            }}
                        />
                        {savingLiteThinking && (
                            <span className="settings-saving">{t("app.saving")}</span>
                        )}
                        {liteThinkingError && (
                            <div className="error-banner" role="alert">
                                {liteThinkingError}
                            </div>
                        )}
                    </div>
                )}
            </fieldset>

            <fieldset className="model-config-card" aria-labelledby="request-identity-title">
                <h3 id="request-identity-title">{t("settings.requestIdentityTitle")}</h3>
                <p className="settings-tab-desc">{t("settings.requestIdentityDesc")}</p>
                <div className="settings-row">
                    <TextInput
                        type="text"
                        value={userAgentDraft}
                        placeholder={t("settings.userAgentPlaceholder")}
                        disabled={savingUserAgent}
                        onChange={(e) => {
                            setUserAgentDraft(e.target.value);
                            if (userAgentError) setUserAgentError(null);
                        }}
                        onBlur={commitUserAgent}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") commitUserAgent();
                        }}
                    />
                    {savingUserAgent && <span className="settings-saving">{t("app.saving")}</span>}
                </div>
                {(userAgentError || userAgentSaveError) && (
                    <div className="error-banner" role="alert">
                        {userAgentError ?? userAgentSaveError}
                    </div>
                )}
                <p className="settings-tab-desc">{t("settings.userAgentHint")}</p>
            </fieldset>
        </section>
    );
}
