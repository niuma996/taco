import type { ProviderView, TacoGlobalConfigView } from "@taco-ai/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingModal } from "../../../src/components/onboarding/OnboardingModal";
import type { UseWorkspacesApi } from "../../../src/hooks/useWorkspaces";
import type { TacoClient } from "../../../src/lib/clients/tacoClient";
import { writeDesktopConfig } from "../../../src/lib/desktopConfig";
import { applyGlobalConfig } from "../../../src/lib/globalConfig";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("../../../src/lib/desktopConfig", () => ({
    writeDesktopConfig: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});
const MODEL = { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" };
const PROVIDER: ProviderView = {
    id: MODEL.provider,
    name: "Anthropic",
    configured: true,
    custom: false,
    models: [MODEL],
};
function setup(initial: TacoGlobalConfigView = {}) {
    applyGlobalConfig(initial);
    let persisted = initial;
    const settingsWrite = vi.fn(async ({ global }: { global: TacoGlobalConfigView }) => {
        persisted = { ...persisted, ...global };
        return { global: persisted };
    });
    const client = {
        settingsWrite,
        sessionListModels: vi.fn().mockResolvedValue({ models: [MODEL] }),
        providersList: vi.fn().mockResolvedValue({ providers: [PROVIDER] }),
    } as unknown as TacoClient;
    const wsApi = {
        notifications: [],
        openWorkspace: vi.fn().mockResolvedValue(true),
    } as unknown as UseWorkspacesApi;
    const onComplete = vi.fn();
    render(
        <OnboardingModal
            client={client}
            wsApi={wsApi}
            defaultCwd="/tmp/ws"
            onComplete={onComplete}
        />,
    );
    return { user: userEvent.setup({ delay: null }), settingsWrite, onComplete, wsApi };
}
async function reachModel(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "onboarding.startSetup" }));
    await user.click(screen.getByRole("button", { name: "onboarding.next" }));
    await waitFor(() =>
        expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
            "disabled",
            false,
        ),
    );
    await user.click(screen.getByRole("button", { name: "onboarding.next" }));
    await screen.findByText("onboarding.modelTitle");
}
describe("onboarding model integration", () => {
    it("completes with only a main model and restores it after going back", async () => {
        const { user, settingsWrite, onComplete, wsApi } = setup();
        await reachModel(user);
        expect(wsApi.openWorkspace).toHaveBeenCalledWith("/tmp/ws");
        expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
            "disabled",
            true,
        );
        await user.click(await screen.findByRole("button", { name: "modelMenu.selectModel" }));
        await user.click(screen.getByRole("menuitemradio", { name: MODEL.name }));
        await screen.findByRole("slider");
        await user.click(screen.getByRole("button", { name: "onboarding.back" }));
        await user.click(screen.getByRole("button", { name: "onboarding.next" }));
        await screen.findByRole("slider");
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
        await user.click(screen.getByRole("button", { name: "onboarding.next" }));
        expect(await screen.findByText("onboarding.doneTitle")).toBeTruthy();
        expect(screen.getByText(MODEL.id)).toBeTruthy();
        expect(screen.queryByText("settings.liteModelTitle")).toBeNull();
        await user.click(screen.getByRole("button", { name: "onboarding.openTaco" }));
        expect(writeDesktopConfig).toHaveBeenCalledWith({
            onboarding: expect.objectContaining({ status: "completed" }),
        });
        expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
        expect(settingsWrite).toHaveBeenCalledTimes(1);
        expect(settingsWrite).toHaveBeenCalledWith({
            global: { defaultModel: MODEL.id, defaultProvider: MODEL.provider },
        });
    });
    it("disables Next and Back until a thinking change is persisted", async () => {
        const { user, settingsWrite } = setup({
            defaultModel: MODEL.id,
            defaultProvider: MODEL.provider,
        });
        await reachModel(user);
        const slider = await screen.findByRole("slider");
        let finish!: (value: { global: TacoGlobalConfigView }) => void;
        settingsWrite.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
        slider.focus();
        await user.keyboard("{ArrowRight}");
        await waitFor(() =>
            expect(settingsWrite).toHaveBeenCalledWith({ global: { thinkingLevel: "minimal" } }),
        );
        expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
            "disabled",
            true,
        );
        expect(screen.getByRole("button", { name: "onboarding.back" })).toHaveProperty(
            "disabled",
            true,
        );
        await act(async () =>
            finish({
                global: {
                    defaultModel: MODEL.id,
                    defaultProvider: MODEL.provider,
                    thinkingLevel: "minimal",
                },
            }),
        );
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
        expect(slider.getAttribute("aria-valuetext")).toBe("minimal");
    });
    it("keeps Next available after an immediate thinking save", async () => {
        const { user, settingsWrite } = setup({
            defaultModel: MODEL.id,
            defaultProvider: MODEL.provider,
        });
        await reachModel(user);
        const slider = await screen.findByRole("slider");
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
        slider.focus();
        await user.keyboard("{ArrowRight}");
        await waitFor(() => expect(settingsWrite).toHaveBeenCalled());
        await waitFor(() => expect(slider.getAttribute("aria-valuetext")).toBe("minimal"));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
    });
    it("blocks Next after a failed thinking save until retry succeeds", async () => {
        const { user, settingsWrite } = setup({
            defaultModel: MODEL.id,
            defaultProvider: MODEL.provider,
        });
        await reachModel(user);
        const slider = await screen.findByRole("slider");
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
        let fail!: (reason: Error) => void;
        settingsWrite.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    fail = reject;
                }),
        );
        slider.focus();
        await user.keyboard("{ArrowRight}");
        await waitFor(() => expect(settingsWrite).toHaveBeenCalled());
        await act(async () => fail(new Error("Disk full")));
        expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk full");
        expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
            "disabled",
            true,
        );
        slider.focus();
        await user.keyboard("{ArrowRight}");
        await waitFor(() => expect(slider.getAttribute("aria-valuetext")).toBe("minimal"));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "onboarding.next" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
    });
});
