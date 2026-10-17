import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPermissionModeSelector } from "../../src/components/CommandPermissionModeSelector";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { loadGlobalConfig } from "../../src/lib/globalConfig";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
afterEach(cleanup);

describe("CommandPermissionModeSelector", () => {
    it("persists the selected global mode while preserving both lists and migrating legacy rules", async () => {
        const settingsWrite = vi.fn(async (patch) => ({ global: patch.global }));
        const client = {
            settingsGet: async () => ({
                global: {
                    commandPermissions: {
                        mode: "ask",
                        rules: ["git diff"],
                        deny: ["git reset *"],
                        allowedDirectories: ["/workspace/extra"],
                    },
                },
            }),
            settingsWrite,
        } as unknown as TacoClient;
        await loadGlobalConfig(client);
        render(<CommandPermissionModeSelector client={client} />);
        const trigger = screen.getByRole("combobox", { name: "settings.permissionsMode" });
        expect(trigger.textContent).toContain("settings.permissionsAsk");
        expect(screen.getByTitle("input.commandPermissionModeHint")).toBeTruthy();
        const user = userEvent.setup();
        await user.click(trigger);
        await user.click(await screen.findByRole("option", { name: "settings.permissionsAuto" }));
        await waitFor(() =>
            expect(settingsWrite).toHaveBeenCalledWith({
                global: {
                    commandPermissions: {
                        mode: "auto",
                        allow: ["git diff"],
                        deny: ["git reset *"],
                        allowedDirectories: ["/workspace/extra"],
                    },
                },
            }),
        );
        await waitFor(() => expect(trigger.textContent).toContain("settings.permissionsAuto"));
    });

    it("keeps the saved mode and displays a failed save", async () => {
        const client = {
            settingsGet: async () => ({
                global: { commandPermissions: { mode: "ask", allow: [], deny: [] } },
            }),
            settingsWrite: async () => {
                throw new Error("settings unavailable");
            },
        } as unknown as TacoClient;
        await loadGlobalConfig(client);
        render(<CommandPermissionModeSelector client={client} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: "settings.permissionsAuto" }));
        expect(await screen.findByRole("alert")).toHaveProperty(
            "textContent",
            "settings unavailable",
        );
        expect(screen.getByRole("combobox").textContent).toContain("settings.permissionsAsk");
    });
});

it("preserves rules saved by a global approval after the composer was mounted", async () => {
    let current = { mode: "ask", allow: [] as string[], deny: ["git reset *"] };
    const settingsWrite = vi.fn(async (patch) => ({ global: patch.global }));
    const client = {
        settingsGet: async () => ({ global: { commandPermissions: current } }),
        settingsWrite,
    } as unknown as TacoClient;
    await loadGlobalConfig(client);
    render(<CommandPermissionModeSelector client={client} />);
    current = { ...current, allow: ["pnpm test"] };
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "settings.permissionsAuto" }));
    await waitFor(() =>
        expect(settingsWrite).toHaveBeenCalledWith({
            global: {
                commandPermissions: { mode: "auto", allow: ["pnpm test"], deny: ["git reset *"] },
            },
        }),
    );
});
