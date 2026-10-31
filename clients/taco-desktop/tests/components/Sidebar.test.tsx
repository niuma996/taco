import { readFileSync } from "node:fs";
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
    it("keeps rename and delete actions keyboard reachable when idle", async () => {
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
                search={searchStub()}
            />,
        );

        const search = screen.getByRole("button", { name: "pane.searchLabel" });
        const rename = screen.getByRole("button", { name: "session.rename" });
        const remove = screen.getByRole("button", { name: "session.deleteSession" });

        const user = userEvent.setup();
        await user.tab();
        expect(document.activeElement).toBe(search);
        await user.tab();
        expect(document.activeElement).toBe(rename);
        await user.tab();
        expect(document.activeElement).toBe(remove);

        // The actions must remain in the sequential focus order while idle.
        // CSS hides them visually with opacity, not display:none, so Tab can
        // focus the first action and :focus-within can reveal the row.
        const css = readFileSync("src/styles/sidebar.css", "utf8");
        const actionRule = (css.match(/\.session-action\s*\{([\s\S]*?)\}/)?.[1] ?? "").replace(
            /\/\*[\s\S]*?\*\//g,
            "",
        );
        expect(actionRule).toContain("opacity: 0");
        expect(actionRule).not.toContain("display: none");
        expect(rename.getAttribute("tabindex")).toBeNull();
        expect(remove.getAttribute("tabindex")).toBeNull();
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

        await userEvent.setup().click(screen.getByRole("button", { name: "session.newChat" }));
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
                    query: "深圳",
                    sessions: [
                        {
                            id: "session-9",
                            name: "今天深圳天气",
                            createdAt: "2026-01-01T00:00:00Z",
                        },
                    ],
                    total: 1,
                })}
            />,
        );

        expect(screen.queryByText("今天深圳天气")).not.toBeNull();
        expect(screen.queryByText("Loaded")).toBeNull();
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
                    query: "深圳x",
                    pending: true,
                    sessions: [
                        { id: "session-9", name: "深圳", createdAt: "2026-01-01T00:00:00Z" },
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
                    query: "深圳",
                    sessions: [
                        {
                            id: "session-9",
                            name: "今天深圳天气",
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
        await userEvent.setup().click(button);
        expect(loadMore).toHaveBeenCalledOnce();
    });
});
