import { makeImCwd } from "@taco-ai/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    UseSessionSearchesResult,
    UseSessionSearchResult,
} from "../../src/hooks/useSessionSearch";
import { createEmptyWorkspace } from "../../src/lib/chat/workspaceReducer";
import {
    ConversationSidebar as Sidebar,
    type ConversationSidebarProps as SidebarProps,
} from "../../src/views/ConversationSidebar";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
    useUiLanguage: () => "en",
}));

afterEach(cleanup);

function searchResult(overrides: Partial<UseSessionSearchResult> = {}): UseSessionSearchResult {
    return {
        query: "",
        setQuery: vi.fn(),
        pending: false,
        sessions: [],
        failed: false,
        loading: false,
        loadMore: vi.fn(),
        refresh: vi.fn(),
        ...overrides,
    };
}

function searchesFor(
    results: Record<string, UseSessionSearchResult> = {},
): UseSessionSearchesResult {
    return {
        forWorkspace: (cwd) => results[cwd] ?? searchResult(),
    };
}

function props(overrides: Partial<SidebarProps> = {}): SidebarProps {
    const first = createEmptyWorkspace("/repo/one", true);
    const second = createEmptyWorkspace("/repo/two");
    first.sessions = [{ id: "same-id", name: "First chat", createdAt: "2026-01-01" }];
    first.activeSession = "same-id";
    second.sessions = [{ id: "same-id", name: "Second chat", createdAt: "2026-01-01" }];
    return {
        mode: "workspace",
        workspaces: { [first.cwd]: first, [second.cwd]: second },
        activeCwd: first.cwd,
        conversations: [
            {
                channelId: "wecom",
                peerId: "alice",
                chatId: "chat-1",
                sessionId: "im-1",
                lastUsedAt: 1,
            },
            {
                channelId: "feishu",
                peerId: "bob",
                chatId: "chat-2",
                sessionId: "im-2",
                lastUsedAt: 2,
            },
        ],
        conversationsLoading: false,
        conversationsError: null,
        searches: searchesFor(),
        onOpenSession: vi.fn(),
        onSelectWorkspace: vi.fn(),
        onLoadWorkspace: vi.fn().mockResolvedValue(undefined),
        onLoadMore: vi.fn(),
        onDelete: vi.fn(),
        onRename: vi.fn(),
        onNewSession: vi.fn(),
        onOpenFolder: vi.fn(),
        onManageAssociations: vi.fn(),
        onRetryConversations: vi.fn(),
        onManageChannels: vi.fn(),
        ...overrides,
    };
}

describe("Sidebar conversation groups", () => {
    it("names the header after the mode and keeps only the open-folder action on top", async () => {
        const input = props();
        const { rerender } = render(<Sidebar {...input} />);
        expect(screen.getByText("workspaceMode.workspace")).toBeTruthy();
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "conversationNav.openFolder" }));
        expect(input.onOpenFolder).toHaveBeenCalledOnce();

        rerender(<Sidebar {...input} mode="im" />);
        expect(screen.getByText("workspaceMode.im")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "conversationNav.openFolder" })).toBeNull();
    });

    it("puts new-session, search and associations on the expanded workspace row", async () => {
        const input = props();
        render(<Sidebar {...input} />);
        const user = userEvent.setup({ delay: null });
        // Group "one" is active and expanded by default; its row carries all three.
        const one = screen.getByRole("region", { name: "one" });
        await user.click(within(one).getByRole("button", { name: "session.newChat" }));
        expect(input.onNewSession).toHaveBeenCalledWith("/repo/one");
        await user.click(within(one).getByRole("button", { name: "activity.manageAssociations" }));
        expect(input.onManageAssociations).toHaveBeenCalledWith({ workspace: "/repo/one" });
        expect(within(one).getByRole("button", { name: "pane.searchLabel" })).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "conversationNav.expandGroup two" }));
        const two = screen.getByRole("region", { name: "two" });
        await user.click(within(two).getByRole("button", { name: "session.newChat" }));
        expect(input.onNewSession).toHaveBeenCalledWith("/repo/two");
        await user.click(within(two).getByRole("button", { name: "activity.manageAssociations" }));
        expect(input.onManageAssociations).toHaveBeenCalledWith({ workspace: "/repo/two" });
        expect(within(two).getByRole("button", { name: "pane.searchLabel" })).toBeTruthy();
    });

    it("reveals the search box at the top of the expanded workspace group", async () => {
        const oneSearch = searchResult();
        const input = props({
            searches: searchesFor({ "/repo/one": oneSearch }),
        });
        render(<Sidebar {...input} />);
        const one = screen.getByRole("region", { name: "one" });
        expect(within(one).queryByRole("textbox", { name: "pane.searchLabel" })).toBeNull();
        const user = userEvent.setup({ delay: null });
        const toggle = within(one).getByRole("button", { name: "pane.searchLabel" });
        await user.click(toggle);
        const box = within(one).getByRole("textbox", { name: "pane.searchLabel" });
        expect(box).toBeTruthy();
        await user.type(box, "abc");
        expect(oneSearch.setQuery).toHaveBeenCalled();
        await user.click(toggle);
        expect(oneSearch.setQuery).toHaveBeenCalledWith("");
    });

    it("shows all workspaces and opens a session with its own workspace identity", async () => {
        const input = props();
        render(<Sidebar {...input} />);
        expect(screen.getByText("one")).toBeTruthy();
        expect(screen.getByText("two")).toBeTruthy();
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "conversationNav.expandGroup two" }));
        await user.click(screen.getByRole("button", { name: /Second chat/ }));
        expect(input.onOpenSession).toHaveBeenCalledWith({
            workspace: "/repo/two",
            sessionId: "same-id",
        });
        expect(
            screen.getByText("Second chat").closest(".session-item")?.classList.contains("active"),
        ).toBe(false);
    });

    it("flattens channel conversations and opens a chat without expanding directories", async () => {
        const base = props();
        const input = props({
            mode: "im",
            conversations: [
                ...(base.conversations ?? []),
                {
                    channelId: "wecom",
                    peerId: "alice",
                    chatId: "chat-3",
                    sessionId: "im-3",
                    lastUsedAt: 3,
                },
            ],
        });
        render(<Sidebar {...input} />);
        const user = userEvent.setup({ delay: null });
        expect(input.onOpenSession).not.toHaveBeenCalled();
        expect(input.onSelectWorkspace).not.toHaveBeenCalled();
        expect(screen.queryByRole("region")).toBeNull();
        expect(screen.queryByText("alice")).toBeNull();
        expect(screen.getByRole("button", { name: "chat-1" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "chat-3" })).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "chat-2" }));
        expect(input.onOpenSession).toHaveBeenCalledWith({
            workspace: makeImCwd("feishu", "bob", "chat-2"),
            sessionId: "im-2",
        });
    });

    it("puts rename, delete and conversation-scoped associations in the chat menu", async () => {
        const cwd = makeImCwd("wecom", "alice", "chat-1");
        const input = props({
            mode: "im",
            conversations: [
                {
                    channelId: "wecom",
                    peerId: "alice",
                    chatId: "chat-1",
                    sessionId: "im-1",
                    lastUsedAt: 1,
                    name: "Renamed chat",
                },
            ],
        });
        render(<Sidebar {...input} />);
        const user = userEvent.setup({ delay: null });
        const row = screen.getByRole("button", { name: "Renamed chat" }).closest(".session-item");
        expect(row).not.toBeNull();

        await user.click(
            within(row as HTMLElement).getByRole("button", { name: "session.moreActions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: /session.rename/ }));
        expect(input.onRename).toHaveBeenCalledWith({
            cwd,
            sessionId: "im-1",
            currentName: "Renamed chat",
        });

        await user.click(
            within(row as HTMLElement).getByRole("button", { name: "session.moreActions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: /activity.manageAssociations/ }));
        expect(input.onManageAssociations).toHaveBeenCalledWith({ workspace: cwd });

        await user.click(
            within(row as HTMLElement).getByRole("button", { name: "session.moreActions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: /session.deleteSession/ }));
        expect(input.onDelete).toHaveBeenCalledWith({ cwd, sessionId: "im-1" });
    });

    it("filters the flat chat list by channel and can restore all channels", async () => {
        const input = props({ mode: "im" });
        render(<Sidebar {...input} />);
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "conversationNav.filterByChannel" }));
        await user.click(screen.getByRole("menuitemradio", { name: "wecom" }));
        expect(screen.getByRole("button", { name: "chat-1" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "chat-2" })).toBeNull();

        await user.click(screen.getByRole("button", { name: "conversationNav.filterByChannel" }));
        await user.click(
            screen.getByRole("menuitemradio", { name: "conversationNav.allChannels" }),
        );
        expect(screen.getByRole("button", { name: "chat-2" })).toBeTruthy();
    });

    it("shows channel chats like workspace sessions: title, time and running dot", () => {
        const imCwd = makeImCwd("wecom", "alice", "chat-1");
        const base = props();
        const chatWorkspace = createEmptyWorkspace(imCwd);
        chatWorkspace.pendingBySessionId = { "im-1": true };
        const input = props({
            mode: "im",
            activeCwd: imCwd,
            workspaces: { ...base.workspaces, [imCwd]: chatWorkspace },
        });
        render(<Sidebar {...input} />);
        const chat = screen.getByRole("button", { name: "chat-1" });
        expect(chat.querySelector(".session-status-dot.running")).toBeTruthy();
        expect(chat.querySelector(".session-id")?.textContent).toBe("chat-1");
        expect(chat.querySelector(".session-time")?.textContent).not.toBe("");
        // The channel tag shares the time row, leaving the title and the
        // right-side actions menu with independent visual slots.
        const tag = chat.querySelector(".session-tag");
        expect(tag?.textContent).toBe("wecom");
        expect(tag?.parentElement?.classList.contains("session-secondary")).toBe(true);
    });

    it("offers channel setup when no IM conversations have arrived", async () => {
        const input = props({ mode: "im", conversations: [] });
        render(<Sidebar {...input} />);
        const user = userEvent.setup({ delay: null });
        expect(screen.getByText("workspaceMode.imNone")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "conversationNav.manageChannels" }));
        expect(input.onManageChannels).toHaveBeenCalledOnce();
    });

    it("keeps search matches scoped to the active workspace", async () => {
        const oneSearch = searchResult({
            query: "match",
            sessions: [{ id: "search-id", name: "Matched chat", createdAt: "2026-01-01" }],
        });
        const input = props({ searches: searchesFor({ "/repo/one": oneSearch }) });
        render(<Sidebar {...input} />);
        const user = userEvent.setup({ delay: null });
        await user.click(screen.getByRole("button", { name: "conversationNav.expandGroup two" }));
        const groups = screen.getAllByRole("region");
        expect(within(groups[0]).getByText("Matched chat")).toBeTruthy();
        expect(within(groups[1]).queryByText("Matched chat")).toBeNull();
    });

    it("does not show a session total beside a workspace name", () => {
        const input = props();
        input.workspaces["/repo/two"] = {
            ...input.workspaces["/repo/two"],
            listTotal: 37,
        };
        render(<Sidebar {...input} />);
        expect(within(screen.getByRole("region", { name: "two" })).queryByText("37")).toBeNull();
    });

    it("shows an empty state when an expanded workspace has no sessions", () => {
        const input = props();
        const empty = createEmptyWorkspace("/repo/empty", true);
        empty.listTotal = 0;
        input.workspaces["/repo/empty"] = empty;
        input.activeCwd = empty.cwd;
        render(<Sidebar {...input} />);
        expect(
            within(screen.getByRole("region", { name: "empty" })).getByText(
                "conversationNav.noConversations",
            ),
        ).toBeTruthy();
    });

    it("keeps workspace groups independently expanded after a lazy load finishes", async () => {
        const input = props();
        const { rerender } = render(<Sidebar {...input} />);
        const user = userEvent.setup({ delay: null });

        await user.click(screen.getByRole("button", { name: "conversationNav.expandGroup two" }));
        await waitFor(() => expect(input.onLoadWorkspace).toHaveBeenCalledWith("/repo/two"));

        rerender(<Sidebar {...input} workspaces={{ ...input.workspaces }} />);

        expect(
            screen
                .getByRole("button", { name: "conversationNav.collapseGroup one" })
                .getAttribute("aria-expanded"),
        ).toBe("true");
        expect(
            screen
                .getByRole("button", { name: "conversationNav.collapseGroup two" })
                .getAttribute("aria-expanded"),
        ).toBe("true");

        await user.click(screen.getByRole("button", { name: "conversationNav.collapseGroup two" }));
        rerender(<Sidebar {...input} workspaces={{ ...input.workspaces }} />);

        expect(
            screen.getByRole("button", { name: "conversationNav.collapseGroup one" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "conversationNav.expandGroup two" }),
        ).toBeTruthy();
    });

    it("freezes workspace order after lazy loads and later session activity", () => {
        const input = props();
        const { rerender } = render(<Sidebar {...input} />);
        expect(
            screen.getAllByRole("region").map((region) => region.getAttribute("aria-label")),
        ).toEqual(["one", "two"]);

        const loadedTwo = {
            ...input.workspaces["/repo/two"],
            listTotal: 1,
            sessions: [
                {
                    id: "same-id",
                    name: "Second chat",
                    createdAt: "2026-01-01",
                    updatedAt: "2030-01-01",
                },
            ],
        };
        rerender(
            <Sidebar {...input} workspaces={{ ...input.workspaces, "/repo/two": loadedTwo }} />,
        );
        expect(
            screen.getAllByRole("region").map((region) => region.getAttribute("aria-label")),
        ).toEqual(["one", "two"]);

        const activeTwo = {
            ...loadedTwo,
            sessions: [{ ...loadedTwo.sessions[0], updatedAt: "2031-01-01" }],
        };
        rerender(
            <Sidebar {...input} workspaces={{ ...input.workspaces, "/repo/two": activeTwo }} />,
        );
        expect(
            screen.getAllByRole("region").map((region) => region.getAttribute("aria-label")),
        ).toEqual(["one", "two"]);
    });

    it("does not reorder channel chats when the selected conversation changes", () => {
        const input = props({ mode: "im", activeCwd: makeImCwd("feishu", "bob", "chat-2") });
        const { rerender } = render(<Sidebar {...input} />);
        const labels = () =>
            Array.from(document.querySelectorAll(".session-id")).map((node) => node.textContent);
        expect(labels()).toEqual(["chat-2", "chat-1"]);

        rerender(<Sidebar {...input} activeCwd={makeImCwd("wecom", "alice", "chat-1")} />);
        expect(labels()).toEqual(["chat-2", "chat-1"]);
    });
});
