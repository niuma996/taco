import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionsTab } from "../../../src/components/settings/PermissionsTab";
import type { TacoClient } from "../../../src/lib/clients/tacoClient.ts";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({
        t: (key: string) => key,
        i18n: { language: "en" },
    })),
}));

// The mocked t() echoes its key, so this is the remove buttons' accessible name.
const REMOVE = "settings.permissionsRemoveRule";

afterEach(cleanup);

beforeEach(async () => {
    const { loadGlobalConfig: load } = await import("../../../src/lib/globalConfig");
    await load({
        settingsGet: () =>
            Promise.resolve({
                global: { commandPermissions: { mode: "auto", rules: ["a", "b", "c"] } },
            }),
        settingsWrite: () => Promise.reject(new Error("not used in this test")),
    } as unknown as TacoClient);
});

describe("PermissionsTab — removeRule", () => {
    it("removes the rule from the rendered list after settings.write succeeds", async () => {
        const settingsWrite = vi.fn().mockResolvedValue({
            global: {
                commandPermissions: { mode: "auto", allow: ["a", "c"], deny: [] },
            },
        });
        const client = {
            settingsGet: () =>
                Promise.resolve({
                    global: { commandPermissions: { mode: "auto", rules: ["a", "b", "c"] } },
                }),
            settingsWrite,
        } as unknown as TacoClient;

        const user = userEvent.setup();
        render(<PermissionsTab client={client} />);

        // Three rules initially.
        await waitFor(() => {
            expect(screen.getAllByRole("button", { name: REMOVE })).toHaveLength(3);
        });

        // Click the × on the second rule ("b").
        const removeButtons = screen.getAllByRole("button", { name: REMOVE });
        expect(removeButtons.length).toBeGreaterThan(1);
        const secondRemove = removeButtons[1];
        if (!secondRemove) throw new Error("expected at least two remove buttons");
        await user.click(secondRemove);

        // Saving a legacy list must write canonical fields only.
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledTimes(1);
            const calls = settingsWrite.mock.calls;
            const firstCall = calls[0];
            if (!firstCall) throw new Error("expected settingsWrite to be called");
            const arg = firstCall[0] as {
                global: { commandPermissions: { allow: string[]; rules?: string[] } };
            };
            expect(arg.global.commandPermissions.allow).toEqual(["a", "c"]);
            expect(arg.global.commandPermissions).not.toHaveProperty("rules");
        });

        // UI must update to reflect the new state.
        await waitFor(() => {
            expect(screen.getAllByRole("button", { name: REMOVE })).toHaveLength(2);
        });
        expect(screen.queryByText("b")).toBeNull();
    });
});

describe("PermissionsTab — blacklist editing", () => {
    it("adds and removes blacklist rules without changing the whitelist", async () => {
        const settingsWrite = vi.fn(async (patch) => ({ global: patch.global }));
        const client = {
            settingsGet: async () => ({
                global: {
                    commandPermissions: {
                        mode: "ask",
                        allowedDirectories: ["/workspace/extra"],
                        allow: ["git diff"],
                        deny: ["git reset *"],
                    },
                },
            }),
            settingsWrite,
        } as unknown as TacoClient;
        const { loadGlobalConfig } = await import("../../../src/lib/globalConfig");
        await loadGlobalConfig(client);
        const user = userEvent.setup();
        render(<PermissionsTab client={client} />);
        await user.click(screen.getByRole("combobox", { name: "settings.permissionsRuleType" }));
        await user.click(
            await screen.findByRole("option", { name: "settings.permissionsDenyList" }),
        );
        expect(screen.getByText("git reset *")).toBeTruthy();
        expect(screen.queryByText("git diff")).toBeNull();
        await user.type(screen.getByRole("textbox"), "bash *");
        await user.click(screen.getByRole("button", { name: "settings.permissionsAddRule" }));
        await waitFor(() =>
            expect(settingsWrite).toHaveBeenLastCalledWith({
                global: {
                    commandPermissions: {
                        mode: "ask",
                        allowedDirectories: ["/workspace/extra"],
                        allow: ["git diff"],
                        deny: ["git reset *", "bash *"],
                    },
                },
            }),
        );
        const firstRemove = screen.getAllByRole("button", { name: REMOVE })[0];
        if (!firstRemove) throw new Error("expected a blacklist remove button");
        await user.click(firstRemove);
        await waitFor(() =>
            expect(settingsWrite).toHaveBeenLastCalledWith({
                global: {
                    commandPermissions: {
                        mode: "ask",
                        allow: ["git diff"],
                        deny: ["bash *"],
                        allowedDirectories: ["/workspace/extra"],
                    },
                },
            }),
        );
    });
});
