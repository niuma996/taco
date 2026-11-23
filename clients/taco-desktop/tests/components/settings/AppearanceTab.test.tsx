import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceTab } from "../../../src/components/settings/AppearanceTab";
import * as useI18n from "../../../src/i18n/useI18n";
import type { TacoClient } from "../../../src/lib/clients/tacoClient";
import { getGlobalConfig, writeClientSettings } from "../../../src/lib/globalConfig";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);
vi.spyOn(useI18n, "useUiLanguage").mockReturnValue("en");

beforeEach(async () => {
    localStorage.clear();
    await writeClientSettings({ theme: "system", uiLanguage: "en" });
});

afterEach(cleanup);

describe("AppearanceTab option cards", () => {
    it("saves a theme picked from the card group", async () => {
        const user = userEvent.setup({ delay: null });
        render(<AppearanceTab client={{} as TacoClient} />);
        expect(screen.queryByRole("combobox")).toBeNull();

        await user.click(screen.getByRole("radio", { name: "settings.themeOptionDark" }));

        await waitFor(() => expect(getGlobalConfig().client.theme).toBe("dark"));
    });

    it("saves a language picked from the card group", async () => {
        const user = userEvent.setup({ delay: null });
        render(<AppearanceTab client={{} as TacoClient} />);

        await user.click(screen.getByRole("radio", { name: "settings.languageOptionZh" }));

        await waitFor(() => expect(getGlobalConfig().client.uiLanguage).toBe("zh"));
    });
});
