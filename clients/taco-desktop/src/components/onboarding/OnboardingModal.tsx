import { useCallback, useEffect, useMemo, useState } from "react";
import { useProviders } from "../../hooks/useProviders.js";
import type { UseWorkspacesApi } from "../../hooks/useWorkspaces.js";
import { useT } from "../../i18n/useI18n.js";
import { type OnboardingStatus, writeDesktopConfig } from "../../lib/desktopConfig.js";
import type { TacoClient } from "../../lib/tacoClientTauri.ts";
import type { ModelSelection } from "../settings/ModelPicker.js";
import { Button } from "../ui/Button.tsx";
import { DoneStep } from "./DoneStep.js";
import { ModelStep } from "./ModelStep.js";
import { ProviderStep } from "./ProviderStep.js";
import { WelcomeStep } from "./WelcomeStep.js";
import { WorkspaceStep } from "./WorkspaceStep.js";

export interface OnboardingModalProps {
    client: TacoClient;
    wsApi: UseWorkspacesApi;
    defaultCwd: string;
    onComplete: (status: OnboardingStatus) => void;
}

type Step = "welcome" | "workspace" | "provider" | "model" | "done";

const STEP_SEQUENCE: ReadonlyArray<Exclude<Step, "done">> = [
    "welcome",
    "workspace",
    "provider",
    "model",
];

export function OnboardingModal(props: OnboardingModalProps) {
    const { t } = useT();
    const [step, setStep] = useState<Step>("welcome");
    const [workspaceCwd, setWorkspaceCwd] = useState<string>(props.defaultCwd);
    const [providerConfigured, setProviderConfigured] = useState(false);
    const [selectedModel, setSelectedModel] = useState<ModelSelection | undefined>(undefined);
    // Disables footer Next + workspace step's "Use default" while openWorkspace is in flight.
    const [goingNext, setGoingNext] = useState(false);
    // Mirrors `useWorkspaces.errorBanner` so workspace-open failures (e.g.
    // sidecar RPC errors) render inside the modal. `openWorkspace` shows a
    // toast on the catch path, but the toast sits at z-index 2000 and the
    // onboarding scrim visually competes with it — the only feedback the
    // user can rely on while this overlay is up is an in-modal banner.
    const openError = props.wsApi.errorBanner;
    // Live provider list — drives both the Next gate (≥1 configured) and the Done
    // summary's real count. Fetched against `workspaceCwd`; only enabled from the
    // provider step onward so welcome/workspace don't trigger a fetch against the
    // default-cwd placeholder that the sidecar hasn't ensured yet.
    const { providers, refresh: refreshProviders } = useProviders(
        props.client,
        workspaceCwd,
        step === "provider" || step === "model" || step === "done",
    );
    // The parent's useProviders fetched once when entering provider step,
    // before any key was saved. ProviderStep / ModelStep each own their own
    // useProviders instances and refresh themselves on key changes, but
    // this parent snapshot stays stale until something kicks it. Refresh
    // on every step transition so the DoneStep summary reflects what the
    // child steps actually saw — without this, saving a key in provider
    // step then advancing to done showed "已配置供应商: 0" even though
    // ModelStep's own dropdown correctly listed the provider's models.
    useEffect(() => {
        if (step === "provider" || step === "model" || step === "done") {
            refreshProviders();
        }
    }, [step, refreshProviders]);
    const configuredProviderCount = useMemo(
        () => providers.filter((p) => p.configured).length,
        [providers],
    );
    // Stable identity so ProviderStep's "at least one configured" effect doesn't re-fire
    // every render of this parent (which would otherwise call setProviderConfigured(true)
    // repeatedly — a no-op for the value but wasted work and a lint smell).
    const handleProviderConfigured = useCallback(() => setProviderConfigured(true), []);

    const markStatus = (status: OnboardingStatus) => {
        // Spec: write failure is non-fatal — log and still let the user into the app
        // (next launch the wizard reappears, which is the safer default than hard-locking).
        writeDesktopConfig({ onboarding: status }).catch((e: unknown) => {
            console.error("[taco] writeDesktopConfig failed", e);
        });
        props.onComplete(status);
    };

    const skip = () => markStatus({ status: "skipped", skippedAt: new Date().toISOString() });

    const finish = () => markStatus({ status: "completed", completedAt: new Date().toISOString() });

    // Opens the given cwd and only advances to the provider step on success. The cwd is
    // passed explicitly so the workspace step's onConfirm (which calls setWorkspaceCwd in
    // the same handler) doesn't suffer from a stale closure of `workspaceCwd`.
    // `openWorkspace` already calls `setErrorBanner(msg)` on its catch path with
    // the real failure reason ("Failed to open C:\…: <rpc error>"). That update
    // bubbles back through `useWorkspaces` → App.tsx → this modal as a new
    // `wsApi` prop, so the modal's `openError` (read from `props.wsApi.errorBanner`)
    // will render the real message on the next render. We intentionally do NOT
    // add a fallback here — the previous "无法打开工作目录: …" string was
    // computed from a stale-closure read and overwrote the real error, leaving
    // the wizard with a misleading empty banner.
    //
    // `openWorkspace` never rejects — every path resolves to a boolean (false on
    // invalid/failed, true on success) — so a `.catch` here would be dead code.
    // The `.then` handles both outcomes: `false` leaves us on the step with the
    // banner openWorkspace set; `true` advances.
    const openWorkspaceAndAdvance = useCallback(
        (cwd: string) => {
            if (goingNext) return;
            setGoingNext(true);
            props.wsApi.setErrorBanner(null);
            void props.wsApi.openWorkspace(cwd).then((ok) => {
                setGoingNext(false);
                if (ok) setStep("provider");
            });
        },
        [goingNext, props.wsApi],
    );

    const goNext = () => {
        switch (step) {
            case "welcome":
                setStep("workspace");
                break;
            case "workspace":
                openWorkspaceAndAdvance(workspaceCwd);
                break;
            case "provider":
                if (providerConfigured) setStep("model");
                break;
            case "model":
                // Trust ModelStep's configured-provider filter. A defensive
                // re-check from the parent's stale `providers` snapshot
                // mis-fires while the parent's `useProviders` fetch is
                // still in flight (race against the user clicking fast),
                // which surfaced a spurious "selected model from
                // unconfigured provider" banner even on correctly-picked
                // models. ModelStep owns the authoritative provider
                // list for selection; the sidecar re-validates the
                // key at session-create time anyway.
                if (selectedModel) setStep("done");
                break;
            case "done":
                break;
        }
    };

    const goBack = () => {
        switch (step) {
            case "workspace":
                setStep("welcome");
                break;
            case "provider":
                setStep("workspace");
                break;
            case "model":
                setStep("provider");
                break;
            case "done":
                setStep("model");
                break;
            default:
                break;
        }
    };

    const canGoNext =
        step === "welcome" ||
        step === "workspace" ||
        (step === "provider" && providerConfigured) ||
        (step === "model" && selectedModel);

    const canGoBack = step !== "welcome" && step !== "done";

    const stepIndex = STEP_SEQUENCE.indexOf(step as Exclude<Step, "done">);

    return (
        <div className="onboarding-overlay">
            <div className="onboarding-modal">
                <div className="onboarding-header">
                    <div className="onboarding-steps">
                        {STEP_SEQUENCE.map((s, i, arr) => (
                            <span key={s} style={{ display: "contents" }}>
                                <span className={`step${step === s ? " is-current" : ""}`}>
                                    <span className="step-num">{i + 1}</span>
                                    {t(`onboarding.step${s[0].toUpperCase()}${s.slice(1)}`)}
                                </span>
                                {i < arr.length - 1 && <span className="step-sep">·</span>}
                            </span>
                        ))}
                    </div>
                    <Button variant="ghost" onClick={skip}>
                        {t("onboarding.skipOnboarding")}
                    </Button>
                </div>

                <div className="onboarding-body">
                    {step === "welcome" && <WelcomeStep onStart={() => setStep("workspace")} />}
                    {step === "workspace" && (
                        <WorkspaceStep
                            // Parent-owned cwd so leaving and returning to
                            // the step shows whatever the user last picked
                            // (or the system default if they haven't picked
                            // anything). Without this, WorkspaceStep's
                            // local `cwd` re-initialises from
                            // `props.defaultCwd` on remount and the input
                            // jumps back to the system default.
                            defaultCwd={workspaceCwd || props.defaultCwd}
                            onChange={(cwd) => {
                                // Sync only — footer Next is the commit point.
                                setWorkspaceCwd(cwd);
                            }}
                        />
                    )}
                    {openError && step === "workspace" && (
                        <div className="error-banner" role="alert">{openError}</div>
                    )}
                    {step === "provider" && (
                        <ProviderStep
                            client={props.client}
                            workspace={workspaceCwd}
                            onConfigured={handleProviderConfigured}
                        />
                    )}
                    {step === "model" && (
                        <ModelStep
                            client={props.client}
                            workspace={workspaceCwd}
                            onSelect={(sel) => setSelectedModel(sel)}
                        />
                    )}
                    {step === "done" && (
                        <DoneStep
                            workspace={workspaceCwd}
                            providerCount={configuredProviderCount}
                            model={selectedModel}
                            onFinish={finish}
                        />
                    )}
                </div>

                <div className="onboarding-actions">
                    {canGoBack && (
                        <Button variant="ghost" onClick={goBack}>
                            {t("onboarding.back")}
                        </Button>
                    )}
                    {stepIndex >= 0 && step !== "welcome" && (
                        <button
                            type="button"
                            className="onboarding-cta"
                            onClick={goNext}
                            disabled={!canGoNext || goingNext}
                        >
                            {t("onboarding.next")}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
