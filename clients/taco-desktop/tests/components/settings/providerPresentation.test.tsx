/**
 * How a provider is presented in the settings surface: the theme/language
 * option cards, and the fallback badge a provider icon falls back to when it
 * has no vendored brand mark.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceTab } from "../../../src/components/settings/AppearanceTab";
import { ProviderIcon } from "../../../src/components/settings/ProviderIcon.tsx";
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

describe("ProviderIcon", () => {
    it("badges a custom provider with its name's initial", () => {
        const { container } = render(<ProviderIcon providerId="custom:acme" name="Acme Corp" />);
        expect(container.querySelector(".lucide-circle-letter-a")).not.toBeNull();
    });

    it("derives the letter past a custom: id used as the name", () => {
        // The model menu groups by provider id and passes it as `name`.
        const { container } = render(<ProviderIcon providerId="custom:foo" name="custom:foo" />);
        expect(container.querySelector(".lucide-circle-letter-f")).not.toBeNull();
    });

    it("falls back to the neutral glyph when the name has no ASCII letter", () => {
        const { container } = render(<ProviderIcon providerId="custom:x" name="深度求索" />);
        expect(container.querySelector(".lucide-box")).not.toBeNull();
    });
});
