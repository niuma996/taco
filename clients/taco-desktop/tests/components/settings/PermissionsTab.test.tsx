/**
 * PermissionsTab — removeRule flow.
 *
 * The bug: clicking the × on a rule calls `removeRule(i)`, which splices
 * `config.rules` and sends the result via `settings.write`. After the RPC
 * returns, `useSaveConfigPatch` calls `applyGlobalConfig(result.global)`,
 * which should trigger a re-render that removes the row from the list.
 *
 * This test exercises that path end-to-end with a fake TacoClient.
 */

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
                commandPermissions: { mode: "auto", rules: ["a", "c"] },
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
            expect(screen.getAllByText("×")).toHaveLength(3);
        });

        // Click the × on the second rule ("b").
        const removeButtons = screen.getAllByText("×");
        expect(removeButtons.length).toBeGreaterThan(1);
        const secondRemove = removeButtons[1];
        if (!secondRemove) throw new Error("expected at least two remove buttons");
        await user.click(secondRemove);

        // The RPC must have received the spliced rules.
        await waitFor(() => {
            expect(settingsWrite).toHaveBeenCalledTimes(1);
            const calls = settingsWrite.mock.calls;
            const firstCall = calls[0];
            if (!firstCall) throw new Error("expected settingsWrite to be called");
            const arg = firstCall[0] as {
                global: { commandPermissions: { rules: string[] } };
            };
            expect(arg.global.commandPermissions.rules).toEqual(["a", "c"]);
        });

        // UI must update to reflect the new state.
        await waitFor(() => {
            expect(screen.getAllByText("×")).toHaveLength(2);
        });
        expect(screen.queryByText("b")).toBeNull();
    });
});
