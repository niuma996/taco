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
        const user = userEvent.setup();
        render(<WorkspaceModeTabs mode="workspace" onModeChange={onModeChange} />);

        await user.click(screen.getByRole("radio", { name: "workspaceMode.workspace" }));

        assert.deepEqual(onModeChange.mock.calls, [["workspace"]]);
    });
});
