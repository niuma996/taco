/**
 * WorkspacePicker — the topbar dropdown listing either project directories
 * or IM conversations, depending on the mode tab in front of it.
 *
 * The IM list comes from the conversation list, so it can be empty while the
 * active workspace is still an `im://` conversation. The trigger must name
 * that conversation by its peer, and the menu must offer no row to switch to
 * (the previous fallback rendered the raw chat id and, on click, routed an
 * `im://` URL into the plain-directory switch).
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePicker } from "../../src/components/WorkspacePicker.tsx";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
    cleanup();
    // Radix locks body pointer events while a menu is open.
    document.body.style.pointerEvents = "";
});

const IM_CWD = "im://wechat/peer-1/chat-1";

function renderPicker(props: Partial<Parameters<typeof WorkspacePicker>[0]> = {}) {
    return render(
        <WorkspacePicker
            mode="im"
            workspaces={[]}
            activeCwd={IM_CWD}
            onChange={() => {}}
            onOpenFolder={() => {}}
            {...props}
        />,
    );
}

describe("WorkspacePicker", () => {
    it("names the active IM conversation by its peer, not by the chat id", () => {
        renderPicker();
        expect(screen.getByText("peer-1")).toBeTruthy();
        expect(screen.queryByText("chat-1")).toBeNull();
    });

    it("offers an empty state instead of a row when there is no conversation", async () => {
        const user = userEvent.setup();
        renderPicker();

        await user.click(screen.getByRole("button", { name: "activity.switchWorkspace" }));

        expect(await screen.findByText("workspaceMode.imEmpty")).toBeTruthy();
        // No conversation row, and no "open folder" action in IM mode.
        expect(screen.queryByText("activity.openFolder")).toBeNull();
    });

    it("switches to the conversation the user picked", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderPicker({
            workspaces: [{ cwd: IM_CWD, label: "peer-1", channel: "wechat" }],
            onChange,
        });

        await user.click(screen.getByRole("button", { name: "activity.switchWorkspace" }));
        await user.click(await screen.findByRole("menuitem", { name: /peer-1/ }));

        expect(onChange).toHaveBeenCalledWith(IM_CWD);
    });

    it("keeps the active directory as the only row when the directory list is empty", async () => {
        const user = userEvent.setup();
        renderPicker({ mode: "workspace", activeCwd: "/repo/my-project" });

        expect(screen.getByText("my-project")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "activity.switchWorkspace" }));
        expect(await screen.findByText("activity.openFolder")).toBeTruthy();
    });
});
