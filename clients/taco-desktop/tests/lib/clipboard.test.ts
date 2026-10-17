import { afterEach, describe, expect, it, vi } from "vitest";
import { writeToClipboard } from "../../src/lib/clipboard";

describe("writeToClipboard", () => {
    afterEach(() => vi.restoreAllMocks());

    it("falls back to execCommand when Clipboard API rejects", async () => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
        });
        const execCommand = vi.fn().mockReturnValue(true);
        Object.defineProperty(document, "execCommand", {
            configurable: true,
            value: execCommand,
        });

        await expect(writeToClipboard("session-1")).resolves.toBe(true);
        expect(execCommand).toHaveBeenCalledWith("copy");
    });
});
