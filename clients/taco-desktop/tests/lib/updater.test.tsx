import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { relaunchDesktop } from "../../src/lib/updater.ts";

afterEach(clearMocks);

describe("relaunchDesktop", () => {
    it("delegates shutdown and restart to a single native command", async () => {
        const commands = vi.fn();
        mockIPC((command) => commands(command));

        await relaunchDesktop();

        expect(commands.mock.calls).toEqual([["restart_desktop"]]);
    });
});
