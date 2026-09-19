/**
 * TopbarQuickActions — language / theme shortcut menus.
 *
 * Locks the write path: picking a language or theme calls writeClientSettings
 * with the matching client-settings patch, and the current value is marked
 * with a check in the open menu.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopbarQuickActions } from "../../src/components/TopbarQuickActions";
import * as useGlobalConfig from "../../src/hooks/primitives/useGlobalConfig";
import * as useI18n from "../../src/i18n/useI18n";
import * as globalConfig from "../../src/lib/globalConfig";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

vi.spyOn(useI18n, "useUiLanguage").mockReturnValue("en");

vi.spyOn(useGlobalConfig, "useGlobalConfig").mockReturnValue({
    global: {},
    client: { theme: "system", uiLanguage: "en" },
    loaded: true,
});

const writeClientSettings = vi
    .spyOn(globalConfig, "writeClientSettings")
    .mockResolvedValue(undefined);

afterEach(cleanup);

beforeEach(() => {
    writeClientSettings.mockClear();
});

describe("TopbarQuickActions", () => {
    it("writes uiLanguage when a language option is picked", async () => {
        const user = userEvent.setup();
        render(<TopbarQuickActions />);

        await user.click(screen.getByRole("button", { name: "app.language" }));
        await user.click(
            await screen.findByRole("menuitem", { name: /settings.languageOptionZh/ }),
        );

        expect(writeClientSettings).toHaveBeenCalledWith({ uiLanguage: "zh" });
    });

    it("writes theme when a theme option is picked", async () => {
        const user = userEvent.setup();
        render(<TopbarQuickActions />);

        await user.click(screen.getByRole("button", { name: "app.theme" }));
        await user.click(await screen.findByRole("menuitem", { name: /settings.themeOptionDark/ }));

        expect(writeClientSettings).toHaveBeenCalledWith({ theme: "dark" });
    });

    it("marks the current language and theme in their menus", async () => {
        const user = userEvent.setup();
        render(<TopbarQuickActions />);

        await user.click(screen.getByRole("button", { name: "app.language" }));
        const enItem = await screen.findByRole("menuitem", {
            name: /settings.languageOptionEn/,
        });
        expect(enItem.querySelector("svg")).not.toBeNull();

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "app.theme" }));
        const systemItem = await screen.findByRole("menuitem", {
            name: /settings.themeOptionSystem/,
        });
        expect(systemItem.querySelector("svg")).not.toBeNull();
        const darkItem = screen.getByRole("menuitem", {
            name: /settings.themeOptionDark/,
        });
        expect(darkItem.querySelector("svg")).toBeNull();
    });
});
