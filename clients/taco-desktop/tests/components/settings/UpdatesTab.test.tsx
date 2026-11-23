import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdatesTab } from "../../../src/components/settings/UpdatesTab";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("../../../src/lib/updater", () => ({
    getCurrentVersion: () => Promise.resolve("1.2.3"),
}));

afterEach(cleanup);

function renderUpdates(overrides: { checking?: boolean; onRestart?: () => Promise<void> } = {}) {
    return render(
        <UpdatesTab
            updateAvailable={null}
            checking={overrides.checking ?? false}
            lastError={null}
            onCheck={vi.fn()}
            onRestart={overrides.onRestart ?? vi.fn().mockResolvedValue(undefined)}
        />,
    );
}

describe("UpdatesTab loading actions", () => {
    it("shows button-local loading until restart settles", async () => {
        let finish!: () => void;
        const onRestart = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        renderUpdates({ onRestart });
        const user = userEvent.setup({ delay: null });

        await user.click(
            await screen.findByRole("button", { name: "settings.updates.restartSidecar" }),
        );

        const busy = screen.getByRole("button", { name: "settings.updates.restarting" });
        expect((busy as HTMLButtonElement).disabled).toBe(true);
        expect(busy.getAttribute("aria-busy")).toBe("true");
        expect(busy.querySelector("svg.spin")).not.toBeNull();
        expect(onRestart).toHaveBeenCalledTimes(1);

        finish();
        const restored = await screen.findByRole("button", {
            name: "settings.updates.restartSidecar",
        });
        expect((restored as HTMLButtonElement).disabled).toBe(false);
        expect(restored.getAttribute("aria-busy")).toBeNull();
    });

    it("shows loading inside the check button while checking", async () => {
        renderUpdates({ checking: true });
        const button = await screen.findByRole("button", {
            name: "settings.updates.statusChecking",
        });

        expect((button as HTMLButtonElement).disabled).toBe(true);
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(button.querySelector("svg.spin")).not.toBeNull();
    });
});
