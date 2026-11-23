import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DebugTab } from "../../../src/components/settings/DebugTab";
import * as desktopConfig from "../../../src/lib/desktopConfig";
import * as globalConfig from "../../../src/lib/globalConfig";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
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
