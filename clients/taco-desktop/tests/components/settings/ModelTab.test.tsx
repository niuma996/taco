import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../../../src/components/settings/ModelPicker";
import { ModelTab } from "../../../src/components/settings/ModelTab";
import type { TacoClient } from "../../../src/lib/clients/tacoClient.ts";
import { applyGlobalConfig } from "../../../src/lib/globalConfig.ts";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(cleanup);

const OPTIONS: ModelOption[] = [
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { provider: "openrouter", id: "anthropic/claude-haiku-4-5", name: "Relayed Haiku" },
];

function renderModelTab(liteModel: string, options = OPTIONS) {
    applyGlobalConfig({ liteModel });
    const settingsWrite = vi.fn(async () => ({ global: {} }));
    const client = { settingsWrite } as unknown as TacoClient;
    const view = render(<ModelTab client={client} workspace={null} options={options} />);
    return {
        ...view,
        client,
        settingsWrite,
        trigger: screen.getByRole("combobox", { name: "settings.liteModelTitle" }),
    };
}

describe("ModelTab auxiliary model selection", () => {
    it.each([
        ["claude-haiku-4-5", "Claude Haiku 4.5 (anthropic)"],
        ["anthropic/claude-haiku-4-5", "Claude Haiku 4.5 (anthropic)"],
        ["openrouter/anthropic/claude-haiku-4-5", "Relayed Haiku (openrouter)"],
    ])("displays the configured model %s", (value, label) => {
        const { trigger, settingsWrite } = renderModelTab(value);
        expect(trigger.textContent).toBe(label);
        expect(settingsWrite).not.toHaveBeenCalled();
    });

    it.each(["removed-model", "removed-provider/removed-model"])(
        "displays the current value %s when it is absent from the catalog",
        async (value) => {
            const user = userEvent.setup({ delay: null });
            const { trigger, settingsWrite } = renderModelTab(value, []);
            expect(trigger.textContent).toBe(value);
            await user.click(trigger);
            const option = await screen.findByRole("option", { name: value });
            expect(option.getAttribute("aria-selected")).toBe("true");
            expect(settingsWrite).not.toHaveBeenCalled();
        },
    );

    it("keeps displaying the configured value after the model list changes", () => {
        const value = "anthropic/claude-haiku-4-5";
        const { trigger, client, rerender } = renderModelTab(value);
        expect(trigger.textContent).toBe("Claude Haiku 4.5 (anthropic)");
        rerender(<ModelTab client={client} workspace={null} options={[]} />);
        expect(trigger.textContent).toBe(value);
    });

    it("clears an out-of-catalog selection through the real picker", async () => {
        const user = userEvent.setup({ delay: null });
        const { trigger, settingsWrite } = renderModelTab("removed-provider/removed-model");
        await user.click(trigger);
        await user.click(await screen.findByRole("option", { name: "settings.liteModelNone" }));
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledWith({ global: { liteModel: null } });
            expect(trigger.textContent).toBe("settings.liteModelNone");
        });
    });
});
