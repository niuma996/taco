import type { ExtensionConfigResult } from "@taco-ai/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { PluginSettingsDialog } from "../../src/views/PluginSettingsDialog";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }),
}));
const result: ExtensionConfigResult = {
    schema: {
        type: "object",
        properties: {
            enabled: {
                type: "boolean",
                default: true,
                title: "Enabled",
                "x-i18n": { zh: { title: "启用上下文" } },
            },
            limit: {
                type: "integer",
                minimum: 0,
                maximum: 10,
                title: "Count",
                "x-i18n": { zh: { title: "提交数量" } },
            },
            label: { type: "string", title: "Label" },
            token: { type: "string", title: "Token", writeOnly: true },
            mode: { type: "string", enum: ["one", "two"], title: "Mode" },
            nested: { type: "object" },
        },
    },
    values: { enabled: false, limit: 2, label: "current" },
    configuredSecrets: ["token"],
    pendingRestart: false,
};
function mount(update = vi.fn(async () => ({ ...result, pendingRestart: true }))) {
    const client = {
        extensionConfigGet: vi.fn(async () => result),
        extensionConfigUpdate: update,
    } as unknown as TacoClient;
    const close = vi.fn();
    render(
        <PluginSettingsDialog
            entry={{ name: "example", configSchema: result.schema }}
            onClose={close}
            client={client}
            onSaved={async () => {}}
        >
            <p>Registration details</p>
        </PluginSettingsDialog>,
    );
    return { client, close, update };
}
afterEach(cleanup);
describe("PluginSettingsDialog", () => {
    it("renders localized controls in a dialog and saves only edited primitive values", async () => {
        const { update } = mount();
        expect(screen.getByRole("dialog", { name: "example" })).toBeTruthy();
        const limit = await screen.findByRole("spinbutton", { name: "提交数量" });
        expect(
            screen.getByRole("switch", { name: "启用上下文" }).getAttribute("aria-checked"),
        ).toBe("false");
        expect(screen.getByRole("combobox", { name: "Mode" })).toBeTruthy();
        expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("");
        fireEvent.change(limit, { target: { value: "4" } });
        fireEvent.click(screen.getByRole("button", { name: "plugins.saveConfig" }));
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith({
                name: "example",
                values: { limit: 4 },
                unset: [],
            }),
        );
        expect(screen.getByText("plugins.configSaved")).toBeTruthy();
    });
    it("blocks invalid numeric input and preserves the draft after a server error", async () => {
        const update = vi.fn().mockRejectedValue(new Error("Could not save"));
        mount(update);
        const limit = await screen.findByRole("spinbutton", { name: "提交数量" });
        fireEvent.change(limit, { target: { value: "11" } });
        fireEvent.click(screen.getByRole("button", { name: "plugins.saveConfig" }));
        expect(update).not.toHaveBeenCalled();
        fireEvent.change(limit, { target: { value: "3" } });
        fireEvent.click(screen.getByRole("button", { name: "plugins.saveConfig" }));
        await screen.findByText("Could not save");
        expect((limit as HTMLInputElement).value).toBe("3");
    });
    it("unsets optional overrides and leaves blank secrets unchanged", async () => {
        const { update } = mount();
        const label = await screen.findByLabelText("Label");
        fireEvent.change(label, { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "plugins.saveConfig" }));
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith({ name: "example", values: {}, unset: ["label"] }),
        );
    });
    it("restores a field default by removing its saved override", async () => {
        const { update } = mount();
        const control = await screen.findByRole("spinbutton", { name: "提交数量" });
        const field = control.closest(".ui-form-field");
        expect(field).toBeTruthy();
        fireEvent.click(
            within(field as HTMLElement).getByRole("button", { name: "plugins.resetConfigField" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "plugins.saveConfig" }));
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith({ name: "example", values: {}, unset: ["limit"] }),
        );
    });

    it("dismisses with Escape", async () => {
        const { close } = mount();
        await screen.findByRole("spinbutton", { name: "提交数量" });
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
        expect(close).toHaveBeenCalledTimes(1);
    });
});
