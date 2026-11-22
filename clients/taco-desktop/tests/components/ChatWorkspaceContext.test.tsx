import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ChatWorkspaceContext,
    type ChatWorkspaceContextProps,
} from "../../src/components/ChatWorkspaceContext";
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
    it("does not query repository worktrees for the workspace switcher", () => {
        const client = { worktreeList: vi.fn() };
        const props = {
            client,
            cwd: "/repo/one",
            workspaces: workspaces(),
            switchable: true,
            onSelect: vi.fn(),
        } satisfies ChatWorkspaceContextProps & { client: typeof client };

        render(<ChatWorkspaceContext {...props} />);

        expect(client.worktreeList).not.toHaveBeenCalled();
    });

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

    it("leaves the current draft intact when reselecting its workspace", async () => {
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
        await user.click(screen.getByRole("menuitemradio", { name: "one" }));

        expect(onSelect).not.toHaveBeenCalled();
    });

    it("keeps linked worktrees out of ordinary workspace destinations", async () => {
        const all = {
            ...workspaces(),
            "/repo/three": createEmptyWorkspace("/repo/three"),
        };
        render(
            <ChatWorkspaceContext
                cwd="/repo/one"
                workspaces={all}
                hiddenWorkspaceCwds={new Set(["/repo/two"])}
                switchable
                onSelect={vi.fn()}
            />,
        );
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "session.switchWorkspace" }));

        expect(screen.getByRole("menuitemradio", { name: "one" })).toBeTruthy();
        expect(screen.getByRole("menuitemradio", { name: "three" })).toBeTruthy();
        expect(screen.queryByRole("menuitemradio", { name: "two" })).toBeNull();
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
