/**
 * Button-local loading contract on `ui/Button` — the busy state a control
 * shows while its own action is in flight: disabled + `aria-busy="true"` +
 * a spinning glyph, scoped to the button that started the work.
 *
 * Both settings tabs assert the same triple, so they share one file.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DebugTab } from "../../../src/components/settings/DebugTab";
import { UpdatesTab } from "../../../src/components/settings/UpdatesTab";
import * as desktopConfig from "../../../src/lib/desktopConfig";
import * as globalConfig from "../../../src/lib/globalConfig";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("../../../src/lib/updater", () => ({
    getCurrentVersion: () => Promise.resolve("1.2.3"),
}));

vi.spyOn(globalConfig, "getGlobalConfig").mockReturnValue({
    global: {},
    client: { debugMode: false, llmDumpToFile: false },
    loaded: true,
});
vi.spyOn(globalConfig, "subscribeGlobalConfig").mockReturnValue(() => {});
vi.spyOn(globalConfig, "writeClientSettings").mockResolvedValue(undefined);
vi.spyOn(desktopConfig, "writeDesktopConfig").mockResolvedValue(undefined);

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

describe("DebugTab restart action", () => {
    it("shows button-local loading until apply and restart settles", async () => {
        let finish!: () => void;
        const onRestart = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const user = userEvent.setup({ delay: null });
        render(<DebugTab onRestart={onRestart} />);

        await user.click(screen.getByRole("switch", { name: "settings.debugModeEnabled" }));
        await user.click(await screen.findByRole("button", { name: "settings.applyAndRestart" }));

        const busy = screen.getByRole("button", { name: "settings.restarting" });
        expect((busy as HTMLButtonElement).disabled).toBe(true);
        expect(busy.getAttribute("aria-busy")).toBe("true");
        expect(busy.querySelector("svg.spin")).not.toBeNull();
        expect(onRestart).toHaveBeenCalledTimes(1);

        finish();
        await waitFor(() => {
            expect(screen.queryByRole("button", { name: "settings.restarting" })).toBeNull();
        });
        expect(screen.queryByRole("button", { name: "settings.applyAndRestart" })).toBeNull();
    });
});

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
