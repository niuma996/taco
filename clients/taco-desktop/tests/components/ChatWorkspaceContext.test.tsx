import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspaceContext } from "../../src/components/ChatWorkspaceContext";
import { createEmptyWorkspace } from "../../src/lib/chat/workspaceReducer";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function workspaces() {
    return {
        "/repo/one": createEmptyWorkspace("/repo/one", true),
        "/repo/two": createEmptyWorkspace("/repo/two"),
    };
}

describe("ChatWorkspaceContext", () => {
    it("shows the workspace and switches it from the new-chat state", async () => {
        const onSelect = vi.fn();
        render(
            <ChatWorkspaceContext
                cwd="/repo/one"
                workspaces={workspaces()}
                switchable
                onSelect={onSelect}
            />,
        );
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "session.switchWorkspace" }));
        await user.click(screen.getByRole("menuitemradio", { name: "two" }));
        expect(onSelect).toHaveBeenCalledWith("/repo/two");
    });

    it("keeps an existing workspace session read-only", () => {
        render(
            <ChatWorkspaceContext
                cwd="/repo/one"
                workspaces={workspaces()}
                switchable={false}
                onSelect={vi.fn()}
            />,
        );
        expect(screen.getByText("one")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "session.switchWorkspace" })).toBeNull();
    });

    it("identifies the channel conversation without offering workspace switching", () => {
        render(
            <ChatWorkspaceContext
                cwd="im://wecom/alice/chat-1"
                workspaces={workspaces()}
                switchable
                onSelect={vi.fn()}
            />,
        );
        expect(screen.getByText("wecom / chat-1")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "session.switchWorkspace" })).toBeNull();
    });
});
