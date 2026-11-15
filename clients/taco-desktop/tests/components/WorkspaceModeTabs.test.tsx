import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, vi } from "vitest";
import { WorkspaceModeTabs } from "../../src/components/WorkspaceModeTabs.tsx";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

describe("WorkspaceModeTabs", () => {
    it("notifies when the selected tab is clicked so a pending switch can be cancelled", async () => {
        const onModeChange = vi.fn();
        const user = userEvent.setup({ delay: null });
        render(<WorkspaceModeTabs mode="workspace" onModeChange={onModeChange} />);

        await user.click(screen.getByRole("radio", { name: "workspaceMode.workspace" }));

        assert.deepEqual(onModeChange.mock.calls, [["workspace"]]);
    });

    it("keeps one presentational underline that slides between the segments", () => {
        const { rerender } = render(<WorkspaceModeTabs mode="workspace" onModeChange={() => {}} />);

        const underline = document.querySelector(".workspace-mode-tabs__underline");
        assert.ok(underline, "the underline element is rendered");
        assert.equal(underline?.getAttribute("aria-hidden"), "true");

        rerender(<WorkspaceModeTabs mode="im" onModeChange={() => {}} />);

        // The same element is reused, so the line travels instead of the
        // inactive segment growing one of its own.
        assert.equal(document.querySelector(".workspace-mode-tabs__underline"), underline);
    });
});
