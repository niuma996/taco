import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesTreeView } from "../../src/components/FilesTreeView";
import * as useI18n from "../../src/i18n/useI18n";

vi.spyOn(useI18n, "useT").mockReturnValue({ t: (key: string) => key } as ReturnType<
    typeof useI18n.useT
>);
afterEach(cleanup);
const change = (
    path: string,
    kind: "added" | "modified" | "deleted" | "renamed" | "conflict",
    indexStatus = " ",
    worktreeStatus = "M",
) => ({ path, kind, indexStatus, worktreeStatus });
const entry = (relPath: string, kind: "file" | "dir" = "file") => ({
    relPath,
    name: relPath.split("/").at(-1) as string,
    kind,
    size: -1,
});
describe("Git file tree", () => {
    it("colors file statuses and aggregates parent folders with visible letters", () => {
        render(
            <FilesTreeView
                entriesByDir={
                    new Map([
                        ["", [entry("src", "dir")]],
                        [
                            "src",
                            [
                                entry("src/new.ts"),
                                entry("src/changed.ts"),
                                entry("src/renamed.ts"),
                                entry("src/conflict.ts"),
                            ],
                        ],
                    ])
                }
                expanded={new Set(["src"])}
                selectedRelPath={null}
                onSelect={vi.fn()}
                onToggleExpand={vi.fn()}
                gitChanges={[
                    change("src/new.ts", "added", "?", "?"),
                    change("src/changed.ts", "modified"),
                    change("src/renamed.ts", "renamed", "R"),
                    change("src/conflict.ts", "conflict", "U", "U"),
                ]}
            />,
        );
        expect(
            screen.getByText("new.ts").closest("[role=treeitem]")?.getAttribute("data-git-tone"),
        ).toBe("success");
        expect(
            screen
                .getByText("changed.ts")
                .closest("[role=treeitem]")
                ?.getAttribute("data-git-tone"),
        ).toBe("warning");
        expect(
            screen.getByText("src").closest("[role=treeitem]")?.getAttribute("data-git-tone"),
        ).toBe("danger");
        for (const letter of ["A", "M", "R", "U"])
            expect(screen.getAllByText(letter).length).toBeGreaterThan(0);
    });

    it("keeps one tree row in the tab order", () => {
        render(
            <FilesTreeView
                entriesByDir={
                    new Map([
                        ["", [entry("src", "dir"), entry("README.md")]],
                        ["src", [entry("src/app.ts"), entry("src/view.ts")]],
                    ])
                }
                expanded={new Set(["src"])}
                selectedRelPath={null}
                onSelect={vi.fn()}
                onToggleExpand={vi.fn()}
            />,
        );

        expect(screen.getByRole("tree").tabIndex).toBe(0);
        expect(screen.getAllByRole("treeitem").filter((row) => row.tabIndex === 0)).toHaveLength(0);
        expect(
            screen.getAllByRole("treeitem").filter((row) => row.tabIndex === -1),
        ).not.toHaveLength(0);
    });
    it("synthesizes deleted files and missing ancestors without allowing preview", () => {
        const onSelect = vi.fn();
        const snapshot = new Map([["", [entry("live.ts")]]]);
        render(
            <FilesTreeView
                entriesByDir={snapshot}
                expanded={new Set(["gone", "gone/nested"])}
                selectedRelPath={null}
                onSelect={onSelect}
                onToggleExpand={vi.fn()}
                gitChanges={[change("gone/nested/deleted.ts", "deleted", "D", " ")]}
            />,
        );
        const deleted = screen.getByText("deleted.ts").closest("[role=treeitem]") as HTMLElement;
        expect(deleted.getAttribute("aria-disabled")).toBe("true");
        expect(deleted.getAttribute("data-git-tone")).toBe("danger");
        fireEvent.click(deleted);
        fireEvent.keyDown(deleted, { key: "Enter" });
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.getAllByText("D").length).toBeGreaterThan(0);
        expect(snapshot.size).toBe(1);
    });
    it("marks cached deleted entries disabled and restores them when status clears", () => {
        const props = {
            entriesByDir: new Map([["", [entry("old.ts")]]]),
            expanded: new Set<string>(),
            selectedRelPath: null,
            onSelect: vi.fn(),
            onToggleExpand: vi.fn(),
        };
        const view = render(
            <FilesTreeView {...props} gitChanges={[change("old.ts", "deleted")]} />,
        );
        fireEvent.click(screen.getByText("old.ts"));
        expect(props.onSelect).not.toHaveBeenCalled();
        view.rerender(<FilesTreeView {...props} gitChanges={[]} />);
        fireEvent.keyDown(screen.getByText("old.ts").closest("[role=treeitem]") as HTMLElement, {
            key: "Enter",
        });
        expect(props.onSelect).toHaveBeenCalledWith("old.ts");
    });
});

it("ignores unknown Git states instead of creating misleading entries", () => {
    render(
        <FilesTreeView
            entriesByDir={new Map()}
            expanded={new Set()}
            selectedRelPath={null}
            onSelect={vi.fn()}
            onToggleExpand={vi.fn()}
            gitChanges={[
                {
                    path: "unknown.ts",
                    kind: "unknown",
                    indexStatus: "X",
                    worktreeStatus: "X",
                } as unknown as import("@taco-ai/protocol").GitFileChange,
            ]}
        />,
    );
    expect(screen.queryByText("unknown.ts")).toBeNull();
});

it("labels parent folders as changed rather than deleted, preserving conflicts", () => {
    const props = {
        entriesByDir: new Map(),
        expanded: new Set(["src"]),
        selectedRelPath: null,
        onSelect: vi.fn(),
        onToggleExpand: vi.fn(),
    };
    const view = render(
        <FilesTreeView {...props} gitChanges={[change("src/deleted.ts", "deleted")]} />,
    );
    const folder = screen.getByText("src").closest("[role=treeitem]") as HTMLElement;
    expect(folder.textContent).toBe("srcM");
    expect(folder.title).toContain("git.folderChanges");
    expect(folder.getAttribute("aria-label")).not.toContain("git.deleted");
    expect(screen.getByText("deleted.ts").closest("[role=treeitem]")?.textContent).toBe(
        "deleted.tsD",
    );
    view.rerender(
        <FilesTreeView {...props} gitChanges={[change("src/conflict.ts", "conflict", "U", "U")]} />,
    );
    expect(screen.getByText("src").closest("[role=treeitem]")?.textContent).toBe("srcU");
});
