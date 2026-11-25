/**
 * ActivityRail tests — the order of the icon column.
 *
 * The rail has no labels, so the only way to tell the entries apart is their
 * order. Memory got a slot of its own and background runs moved into the
 * "more" menu; both are pinned here so a reorder cannot slip through.
 */

import { strict as assert } from "node:assert";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, vi } from "vitest";
import { ActivityRail } from "../../src/components/ActivityRail.tsx";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

/** The tooltip carries the label; the icons themselves have no accessible name. */
function railLabels(): (string | null)[] {
    return Array.from(document.querySelectorAll(".activity-rail-item .activity-rail-tooltip")).map(
        (node) => node.textContent,
    );
}

describe("ActivityRail order", () => {
    it("keeps memory in the top group and background runs behind the more button", () => {
        render(<ActivityRail activeView="chat" onSelect={() => {}} />);

        assert.deepEqual(railLabels(), [
            "activity.chat",
            "activity.agents",
            "activity.skills",
            "activity.tools",
            "activity.memory",
            "activity.plugins",
            "activity.channels",
            "activity.more",
            "activity.settings",
        ]);
    });

    it("places background runs immediately below schedules in the overflow menu", async () => {
        render(<ActivityRail activeView="chat" onSelect={() => {}} />);

        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "activity.more" }));

        assert.deepEqual(
            Array.from(document.querySelectorAll("[role=menuitem] .ui-menu-label")).map(
                (node) => node.textContent,
            ),
            ["activity.checkpoints", "activity.schedules", "activity.work", "activity.mcp"],
        );
    });
});
