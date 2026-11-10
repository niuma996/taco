import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UseSessionSearchResult } from "../../src/hooks/useSessionSearch";
import * as useI18n from "../../src/i18n/useI18n";
import { Sidebar } from "../../src/views/Sidebar";
import "../../src/styles.css";

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);
vi.spyOn(useI18n, "useUiLanguage").mockReturnValue("en");

afterEach(cleanup);

/** A search API with nothing typed and no matches. */
function searchStub(overrides: Partial<UseSessionSearchResult> = {}): UseSessionSearchResult {
    return {
        query: "",
        setQuery: vi.fn(),
        pending: false,
        sessions: [],
        cursor: undefined,
        total: undefined,
        failed: false,
        loading: false,
        loadMore: vi.fn(),
        refresh: vi.fn(),
        ...overrides,
    };
}

describe("Sidebar session actions", () => {
    it("keeps the session actions menu keyboard reachable when idle", async () => {
        const onRename = vi.fn();
        const onDelete = vi.fn();
        render(
            <Sidebar
                ws={
                    {
                        sessions: [{ id: "session-1", name: "Session", createdAt: 0 }],
                        activeSession: null,
                        pendingBySessionId: {},
                    } as never
                }
                onAttach={() => {}}
                onDelete={onDelete}
                onRename={onRename}
                search={searchStub()}
            />,
        );

        const search = screen.getByRole("button", { name: "pane.searchLabel" });
        const rowMain = document.querySelector("[data-session-row]") as HTMLElement;
        const more = screen.getByRole("button", { name: "session.moreActions" });
        const user = userEvent.setup({ delay: null });
        await user.tab();
        expect(document.activeElement).toBe(search);
        await user.tab();
        expect(document.activeElement).toBe(rowMain);
        await user.tab();
        expect(document.activeElement).toBe(more);

        const css = readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), "../../src/styles/sidebar.css"),
            "utf8",
        );
        const actionRule = (css.match(/\.session-action\s*\{([\s\S]*?)\}/)?.[1] ?? "").replace(
            /\/\*[\s\S]*?\*\//g,
            "",
        );
        expect(actionRule).toContain("opacity: 0");
        expect(actionRule).not.toContain("display: none");
        expect(more.getAttribute("tabindex")).toBeNull();

        await user.click(more);
        await user.click(screen.getByRole("menuitem", { name: /session.rename/ }));
        expect(onRename).toHaveBeenCalledWith("session-1");
        await user.click(more);
        await user.click(screen.getByRole("menuitem", { name: /session.deleteSession/ }));
        expect(onDelete).toHaveBeenCalledWith("session-1");
    });

    it("moves focus between session rows with arrow keys", async () => {
        render(
            <Sidebar
                ws={
                    {
                        sessions: [
                            { id: "session-1", name: "First", createdAt: 0 },
                            { id: "session-2", name: "Second", createdAt: 0 },
                        ],
                        activeSession: null,
                        pendingBySessionId: {},
                    } as never
                }
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                search={searchStub()}
            />,
        );

        const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]"));
        expect(rows).toHaveLength(2);
        const user = userEvent.setup({ delay: null });
        rows[0].focus();
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(rows[1]);
        await user.keyboard("{ArrowUp}");
        expect(document.activeElement).toBe(rows[0]);
        await user.keyboard("{End}");
        expect(document.activeElement).toBe(rows[1]);
        await user.keyboard("{Home}");
        expect(document.activeElement).toBe(rows[0]);
    });

    it("starts a new chat from the pinned header button", async () => {
        const onNewSession = vi.fn();
        render(
            <Sidebar
                ws={
                    {
                        sessions: [{ id: "session-1", name: "Session", createdAt: 0 }],
                        activeSession: null,
                        pendingBySessionId: {},
                    } as never
                }
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                onNewSession={onNewSession}
                search={searchStub()}
            />,
        );

        await userEvent
            .setup({ delay: null })
            .click(screen.getByRole("button", { name: "session.newChat" }));
        expect(onNewSession).toHaveBeenCalledOnce();
    });

    it("shows the server's matches instead of the loaded sessions while searching", () => {
        render(
            <Sidebar
                ws={
                    {
                        sessions: [{ id: "session-1", name: "Loaded", createdAt: 0 }],
                        activeSession: null,
                        pendingBySessionId: {},
                    } as never
                }
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                search={searchStub({
                    query: "search",
                    sessions: [
                        {
                            id: "session-9",
                            name: "Matching session",
                            createdAt: "2026-01-01T00:00:00Z",
                        },
                    ],
                    total: 1,
                })}
            />,
        );

        expect(screen.queryByText("Matching session")).not.toBeNull();
        expect(screen.queryByText("Loaded")).toBeNull();
    });

    it("keeps the search field visible when remounted with an active query", () => {
        render(
            <Sidebar
                ws={
                    {
                        sessions: [{ id: "session-1", name: "Loaded", createdAt: 0 }],
                        activeSession: null,
                        pendingBySessionId: {},
                    } as never
                }
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                onNewSession={() => {}}
                search={searchStub({
                    query: "search",
                    sessions: [
                        {
                            id: "session-9",
                            name: "Matching session",
                            createdAt: "2026-01-01T00:00:00Z",
                        },
                    ],
                })}
            />,
        );

        expect(
            (screen.getByRole("textbox", { name: "pane.searchLabel" }) as HTMLInputElement).value,
        ).toBe("search");
        expect(screen.queryByRole("button", { name: "session.newChat" })).toBeNull();
        expect(screen.getByText("Matching session")).not.toBeNull();
    });

    it("says so when nothing matches", () => {
        render(
            <Sidebar
                ws={undefined}
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                search={searchStub({ query: "zzz" })}
            />,
        );

        expect(screen.getByText("session.noSearchResults")).not.toBeNull();
    });

    it("reports a failed search as a failure, not as no matches", () => {
        render(
            <Sidebar
                ws={undefined}
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                search={searchStub({ query: "zzz", failed: true })}
            />,
        );

        expect(screen.getByText("session.searchFailed")).not.toBeNull();
        expect(screen.queryByText("session.noSearchResults")).toBeNull();
    });

    it("disables load more while the typed query is still pending", () => {
        render(
            <Sidebar
                ws={undefined}
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                search={searchStub({
                    query: "searchx",
                    pending: true,
                    sessions: [
                        {
                            id: "session-9",
                            name: "Matching session",
                            createdAt: "2026-01-01T00:00:00Z",
                        },
                    ],
                    cursor: { updatedAt: "2026-01-01T00:00:00Z", id: "session-9" },
                    total: 3,
                })}
            />,
        );

        const button = screen.getByRole("button", { name: /session.loadMore/ });
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it("pages the matches, not the workspace, while searching", async () => {
        const loadMore = vi.fn();
        render(
            <Sidebar
                ws={
                    {
                        sessions: [{ id: "session-1", name: "Loaded", createdAt: 0 }],
                        activeSession: null,
                        pendingBySessionId: {},
                    } as never
                }
                onAttach={() => {}}
                onDelete={() => {}}
                onRename={() => {}}
                onLoadMore={() => {}}
                search={searchStub({
                    query: "search",
                    sessions: [
                        {
                            id: "session-9",
                            name: "Matching session",
                            createdAt: "2026-01-01T00:00:00Z",
                        },
                    ],
                    cursor: { updatedAt: "2026-01-01T00:00:00Z", id: "session-9" },
                    total: 3,
                    loadMore,
                })}
            />,
        );

        const button = screen.getByRole("button", { name: /session.loadMore/ });
        // The count describes the result set, not the workspace.
        expect(button.textContent).toContain("(1/3)");
        await userEvent.setup({ delay: null }).click(button);
        expect(loadMore).toHaveBeenCalledOnce();
    });
});
