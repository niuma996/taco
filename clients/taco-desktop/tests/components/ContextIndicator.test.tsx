/**
 * ContextIndicator — popover Compact action.
 *
 * The ring only opens the popover; Compact lives inside it so the usage
 * details stay visible until the user confirms. Disabled while a compaction
 * or a turn is in flight, matching the sidecar's busy admission.
 */
import type { SessionContextInfoResult } from "@taco-ai/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextIndicator } from "../../src/components/ContextIndicator";
import * as useI18n from "../../src/i18n/useI18n";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

afterEach(cleanup);

const INFO: SessionContextInfoResult = {
    modelId: "claude-sonnet",
    provider: "anthropic",
    contextWindow: 200_000,
    usedTokens: 40_000,
    ratio: 0.2,
};

function renderIndicator(props: Partial<ComponentProps<typeof ContextIndicator>> = {}) {
    return render(<ContextIndicator info={INFO} loading={false} {...props} />);
}

async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole("button", { name: /context.indicatorLabel/ }));
}

describe("ContextIndicator — manual compact", () => {
    it("fires onCompact from the popover and closes it", async () => {
        const user = userEvent.setup();
        const onCompact = vi.fn();
        renderIndicator({ onCompact });
        await openPopover(user);
        await user.click(screen.getByRole("button", { name: "context.compactNow" }));
        expect(onCompact).toHaveBeenCalledOnce();
        expect(screen.queryByRole("button", { name: "context.compactNow" })).toBeNull();
    });

    it("disables Compact while compacting", async () => {
        const user = userEvent.setup();
        const onCompact = vi.fn();
        renderIndicator({ onCompact, compacting: true });
        await openPopover(user);
        const compact = screen.getByRole("button", { name: "context.compactNow" });
        expect((compact as HTMLButtonElement).disabled).toBe(true);
        await user.click(compact);
        expect(onCompact).not.toHaveBeenCalled();
    });

    it("disables Compact while the session is busy", async () => {
        const user = userEvent.setup();
        const onCompact = vi.fn();
        renderIndicator({ onCompact, sessionBusy: true });
        await openPopover(user);
        const compact = screen.getByRole("button", { name: "context.compactNow" });
        expect((compact as HTMLButtonElement).disabled).toBe(true);
        await user.click(compact);
        expect(onCompact).not.toHaveBeenCalled();
    });

    it("omits Compact when onCompact is not provided", async () => {
        const user = userEvent.setup();
        renderIndicator();
        await openPopover(user);
        expect(screen.queryByRole("button", { name: "context.compactNow" })).toBeNull();
    });

    it("formats a millisecond epoch lastCompactionAt as yyyy-MM-DD HH:mm:ss", async () => {
        const user = userEvent.setup();
        renderIndicator({
            info: { ...INFO, lastCompactionAt: "1789719368952" },
        });
        await openPopover(user);
        const row = screen.getByText(/context.lastCompaction:/);
        expect(row.textContent).toMatch(
            /context.lastCompaction: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
        );
        expect(row.textContent).not.toContain("1789719368952");
    });
});
