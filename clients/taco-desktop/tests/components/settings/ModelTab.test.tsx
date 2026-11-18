import type { LiteThinkingLevel } from "@taco-ai/protocol";
import {
    cleanup,
    fireEvent,
    render as renderWithoutQueries,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../../../src/components/settings/ModelPicker";
import { ModelTab } from "../../../src/components/settings/ModelTab";
import type { TacoClient } from "../../../src/lib/clients/tacoClient.ts";
import { applyGlobalConfig } from "../../../src/lib/globalConfig.ts";
import { queryWrapper } from "../../helpers/queryWrapper";

function render(ui: ReactElement) {
    return renderWithoutQueries(ui, queryWrapper());
}

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(cleanup);

const OPTIONS: ModelOption[] = [
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { provider: "openrouter", id: "anthropic/claude-haiku-4-5", name: "Relayed Haiku" },
];

function renderModelTab(
    liteModel: string,
    options = OPTIONS,
    triggerLabel = "settings.liteModelNone",
) {
    applyGlobalConfig({ liteModel });
    const settingsWrite = vi.fn(async () => ({ global: {} }));
    const client = { settingsWrite } as unknown as TacoClient;
    const view = render(<ModelTab client={client} workspace={null} options={options} />);
    return {
        ...view,
        client,
        settingsWrite,
        trigger: screen.getByRole("button", { name: triggerLabel }),
    };
}

function renderLiteThinkingTab(liteThinkingLevel?: LiteThinkingLevel) {
    applyGlobalConfig({ liteModel: "anthropic/claude-haiku-4-5", liteThinkingLevel });
    const settingsWrite = vi.fn(async () => ({ global: {} }));
    const client = { settingsWrite } as unknown as TacoClient;
    const view = render(<ModelTab client={client} workspace={null} options={OPTIONS} />);
    return {
        ...view,
        client,
        settingsWrite,
        slider: screen.getByRole("slider", { name: "settings.liteThinkingLevelTitle" }),
    };
}

describe("ModelTab auxiliary thinking level", () => {
    it("offers only the low levels", () => {
        const { slider } = renderLiteThinkingTab();
        // Model default / off / minimal / low.
        expect(slider.getAttribute("aria-valuemax")).toBe("3");
    });

    it("shows the model default when unset", () => {
        const { slider } = renderLiteThinkingTab();
        expect(slider.getAttribute("aria-valuenow")).toBe("0");
        expect(slider.getAttribute("aria-valuetext")).toBe("settings.thinkingModelDefault");
    });

    it("shows the configured level", () => {
        const { slider } = renderLiteThinkingTab("low");
        expect(slider.getAttribute("aria-valuenow")).toBe("3");
    });

    it("writes the chosen level to the global config", async () => {
        const user = userEvent.setup({ delay: null });
        const { slider, settingsWrite } = renderLiteThinkingTab();
        slider.focus();
        await user.keyboard("{ArrowRight}");
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledWith({
                global: { liteThinkingLevel: "off" },
            });
        });
    });
});

describe("ModelTab auxiliary model selection", () => {
    it.each([
        ["claude-haiku-4-5", "Claude Haiku 4.5 · anthropic"],
        ["anthropic/claude-haiku-4-5", "Claude Haiku 4.5 · anthropic"],
        ["openrouter/anthropic/claude-haiku-4-5", "Relayed Haiku · openrouter"],
    ])("displays the configured model %s", (value, label) => {
        const { trigger, settingsWrite } = renderModelTab(value, OPTIONS, label);
        expect(trigger.textContent).toBe(label);
        expect(settingsWrite).not.toHaveBeenCalled();
    });

    it.each(["removed-model", "removed-provider/removed-model"])(
        "displays the current value %s when it is absent from the catalog",
        (value) => {
            const { trigger, settingsWrite } = renderModelTab(value, [], value);
            expect(trigger.textContent).toBe(value);
            expect(settingsWrite).not.toHaveBeenCalled();
        },
    );

    it("keeps displaying the configured value after the model list changes", () => {
        const value = "anthropic/claude-haiku-4-5";
        const { trigger, client, rerender } = renderModelTab(
            value,
            OPTIONS,
            "Claude Haiku 4.5 · anthropic",
        );
        expect(trigger.textContent).toBe("Claude Haiku 4.5 · anthropic");
        rerender(<ModelTab client={client} workspace={null} options={[]} />);
        expect(trigger.textContent).toBe(value);
    });

    it("clears an out-of-catalog selection through the real picker", async () => {
        const user = userEvent.setup({ delay: null });
        const value = "removed-provider/removed-model";
        const { trigger, settingsWrite } = renderModelTab(value, [], value);
        await user.click(trigger);
        await user.click(
            await screen.findByRole("menuitemradio", { name: "settings.liteModelNone" }),
        );
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledWith({ global: { liteModel: null } });
            expect(trigger.textContent).toBe("settings.liteModelNone");
        });
    });

    it("writes the picked model back as provider/id", async () => {
        const user = userEvent.setup({ delay: null });
        const { trigger, settingsWrite } = renderModelTab(
            "anthropic/claude-haiku-4-5",
            OPTIONS,
            "Claude Haiku 4.5 · anthropic",
        );
        await user.click(trigger);
        await user.click(await screen.findByRole("menuitemradio", { name: "Relayed Haiku" }));
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledWith({
                global: { liteModel: "openrouter/anthropic/claude-haiku-4-5" },
            });
        });
    });
});

describe("ModelTab request identity", () => {
    function renderIdentityTab(userAgent?: string) {
        applyGlobalConfig({ userAgent });
        const settingsWrite = vi.fn(async () => ({ global: {} }));
        const client = { settingsWrite } as unknown as TacoClient;
        const view = render(<ModelTab client={client} workspace={null} options={OPTIONS} />);
        return {
            ...view,
            settingsWrite,
            input: screen.getByPlaceholderText("settings.userAgentPlaceholder"),
        };
    }

    it("shows the configured User-Agent", () => {
        const { input } = renderIdentityTab("my-gateway/1.0");
        expect((input as HTMLInputElement).value).toBe("my-gateway/1.0");
    });

    it("saves the User-Agent on blur", async () => {
        const { input, settingsWrite } = renderIdentityTab();
        fireEvent.change(input, { target: { value: "my-gateway/1.0" } });
        fireEvent.blur(input);
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledWith({ global: { userAgent: "my-gateway/1.0" } });
        });
    });

    it("saves the User-Agent on Enter", async () => {
        const { input, settingsWrite } = renderIdentityTab();
        fireEvent.change(input, { target: { value: "my-gateway/1.0" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledWith({ global: { userAgent: "my-gateway/1.0" } });
        });
    });

    it("clears the User-Agent back to the default", async () => {
        const { input, settingsWrite } = renderIdentityTab("my-gateway/1.0");
        fireEvent.change(input, { target: { value: "" } });
        fireEvent.blur(input);
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledWith({ global: { userAgent: null } });
        });
    });

    it("refuses a User-Agent that could break out of the header", async () => {
        const { input, settingsWrite } = renderIdentityTab();
        // A DOM input strips CR/LF on its own, so the control character that
        // survives the value setter is the one the guard has to catch.
        fireEvent.change(input, { target: { value: "evil/1.0\u0007" } });
        fireEvent.blur(input);
        expect(await screen.findByRole("alert")).toHaveProperty(
            "textContent",
            "settings.userAgentInvalid",
        );
        expect(settingsWrite).not.toHaveBeenCalled();
    });

    it("does not write when the value is unchanged", async () => {
        const { input, settingsWrite } = renderIdentityTab("my-gateway/1.0");
        fireEvent.blur(input);
        expect(settingsWrite).not.toHaveBeenCalled();
    });
});

describe("ModelTab model groups", () => {
    it("hides both thinking controls until their model is configured", () => {
        applyGlobalConfig({ thinkingLevel: "high", liteThinkingLevel: "low" });
        render(<ModelTab client={{} as TacoClient} workspace={null} options={OPTIONS} />);
        expect(screen.queryByRole("slider")).toBeNull();
    });

    it("keeps each thinking control inside its model group", () => {
        applyGlobalConfig({
            defaultModel: "claude-haiku-4-5",
            defaultProvider: "anthropic",
            liteModel: "anthropic/claude-haiku-4-5",
        });
        render(<ModelTab client={{} as TacoClient} workspace={null} options={OPTIONS} />);
        const main = screen.getByRole("group", { name: "settings.defaultModelTitle" });
        const lite = screen.getByRole("group", { name: "settings.liteModelTitle" });
        expect(
            within(main)
                .getByRole("slider", { name: "modelMenu.thinkingLevel" })
                .getAttribute("aria-valuetext"),
        ).toBe("off");
        expect(
            within(lite).getByRole("slider", { name: "settings.liteThinkingLevelTitle" }),
        ).toBeTruthy();
    });

    it("shows main thinking only after the first selection is saved", async () => {
        applyGlobalConfig({});
        const settingsWrite = vi.fn(async ({ global }) => ({ global }));
        render(
            <ModelTab
                client={{ settingsWrite } as unknown as TacoClient}
                workspace={null}
                options={OPTIONS}
            />,
        );
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "modelMenu.selectModel" }));
        await user.click(screen.getByRole("menuitemradio", { name: "Claude Haiku 4.5" }));
        expect(await screen.findByRole("slider", { name: "modelMenu.thinkingLevel" })).toBeTruthy();
    });

    it("returns lite thinking to the model default with Home", async () => {
        const { slider, settingsWrite } = renderLiteThinkingTab("low");
        const user = userEvent.setup({ delay: null });
        slider.focus();
        await user.keyboard("{Home}");
        await waitFor(() =>
            expect(settingsWrite).toHaveBeenCalledWith({ global: { liteThinkingLevel: null } }),
        );
    });

    it("reports a failed model write and permits retry", async () => {
        applyGlobalConfig({});
        const settingsWrite = vi
            .fn()
            .mockRejectedValueOnce(new Error("Disk full"))
            .mockResolvedValueOnce({
                global: { defaultModel: OPTIONS[0].id, defaultProvider: OPTIONS[0].provider },
            });
        render(
            <ModelTab
                client={{ settingsWrite } as unknown as TacoClient}
                workspace={null}
                options={OPTIONS}
            />,
        );
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "modelMenu.selectModel" }));
        await user.click(screen.getByRole("menuitemradio", { name: "Claude Haiku 4.5" }));
        expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk full");
        expect(screen.queryByRole("slider")).toBeNull();
        await user.click(screen.getByRole("button", { name: "modelMenu.selectModel" }));
        await user.click(screen.getByRole("menuitemradio", { name: "Claude Haiku 4.5" }));
        expect(await screen.findByRole("slider", { name: "modelMenu.thinkingLevel" })).toBeTruthy();
    });
});
