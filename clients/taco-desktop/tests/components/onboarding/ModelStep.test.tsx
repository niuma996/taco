import type { ProviderView, TacoGlobalConfigView, WorkspaceId } from "@taco-ai/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelStep } from "../../../src/components/onboarding/ModelStep";
import type { TacoClient } from "../../../src/lib/clients/tacoClient";
import { applyGlobalConfig } from "../../../src/lib/globalConfig";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
afterEach(cleanup);
const MODEL = { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" };
const PROVIDER: ProviderView = {
    id: MODEL.provider,
    name: "Anthropic",
    configured: true,
    custom: false,
    models: [{ provider: MODEL.provider, id: MODEL.id }],
};
function setup(
    global: TacoGlobalConfigView = {},
    settingsWrite = vi
        .fn()
        .mockResolvedValue({ global: { defaultModel: MODEL.id, defaultProvider: MODEL.provider } }),
) {
    applyGlobalConfig(global);
    const onSelect = vi.fn();
    const client = {
        settingsWrite,
        sessionListModels: vi
            .fn()
            .mockResolvedValue({ models: [MODEL, { provider: "openai", id: "gpt-unconfigured" }] }),
        providersList: vi.fn().mockResolvedValue({ providers: [PROVIDER] }),
    } as unknown as TacoClient;
    const view = render(
        <ModelStep client={client} workspace={"/tmp/ws" as WorkspaceId} onSelect={onSelect} />,
    );
    return { ...view, client, onSelect, settingsWrite, user: userEvent.setup({ delay: null }) };
}
async function pick(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "modelMenu.selectModel" }));
    expect(screen.queryByRole("menuitemradio", { name: "gpt-unconfigured" })).toBeNull();
    await user.click(screen.getByRole("menuitemradio", { name: MODEL.name }));
}
describe("onboarding main model", () => {
    it("shows thinking only after a successful model save and never offers lite", async () => {
        const { user, onSelect, settingsWrite } = setup();
        expect(screen.queryByRole("slider")).toBeNull();
        expect(screen.queryByText("settings.liteModelTitle")).toBeNull();
        await pick(user);
        const slider = await screen.findByRole("slider");
        expect(slider.getAttribute("aria-valuetext")).toBe("off");
        await waitFor(() =>
            expect(onSelect).toHaveBeenLastCalledWith({ provider: MODEL.provider, id: MODEL.id }),
        );
        expect(settingsWrite).toHaveBeenCalledWith({
            global: { defaultModel: MODEL.id, defaultProvider: MODEL.provider },
        });
    });
    it("holds the Next gate closed during a model write", async () => {
        let finish!: (value: unknown) => void;
        const write = vi.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const { user, onSelect } = setup({}, write);
        await pick(user);
        expect(onSelect).not.toHaveBeenCalledWith({ provider: MODEL.provider, id: MODEL.id });
        expect(screen.queryByRole("slider")).toBeNull();
        await act(async () =>
            finish({ global: { defaultModel: MODEL.id, defaultProvider: MODEL.provider } }),
        );
        await waitFor(() =>
            expect(onSelect).toHaveBeenLastCalledWith({ provider: MODEL.provider, id: MODEL.id }),
        );
    });
    it("shows failed writes inside the step and allows retry", async () => {
        const write = vi
            .fn()
            .mockRejectedValueOnce(new Error("Disk full"))
            .mockResolvedValueOnce({
                global: { defaultModel: MODEL.id, defaultProvider: MODEL.provider },
            });
        const { user, onSelect } = setup({}, write);
        await pick(user);
        expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk full");
        expect(onSelect).not.toHaveBeenCalledWith({ provider: MODEL.provider, id: MODEL.id });
        expect(screen.queryByRole("slider")).toBeNull();
        await pick(user);
        expect(await screen.findByRole("slider")).toBeTruthy();
    });
    it("restores a saved model and thinking level when revisiting", async () => {
        const { onSelect, settingsWrite } = setup({
            defaultModel: MODEL.id,
            defaultProvider: MODEL.provider,
            thinkingLevel: "high",
        });
        expect((await screen.findByRole("slider")).getAttribute("aria-valuetext")).toBe("high");
        await waitFor(() =>
            expect(onSelect).toHaveBeenLastCalledWith({ provider: MODEL.provider, id: MODEL.id }),
        );
        expect(settingsWrite).not.toHaveBeenCalled();
    });
    it("does not restore a model belonging to an unconfigured provider", async () => {
        const { onSelect } = setup({ defaultModel: "gpt-unconfigured", defaultProvider: "openai" });
        await screen.findByRole("button", { name: "modelMenu.selectModel" });
        await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(undefined));
        expect(screen.queryByRole("slider")).toBeNull();
    });
    it("saves main thinking without writing lite configuration", async () => {
        const { user, settingsWrite } = setup({
            defaultModel: MODEL.id,
            defaultProvider: MODEL.provider,
        });
        const slider = await screen.findByRole("slider");
        slider.focus();
        await user.keyboard("{ArrowRight}");
        await waitFor(() =>
            expect(settingsWrite).toHaveBeenCalledWith({ global: { thinkingLevel: "minimal" } }),
        );
    });
});
