import { strict as assert } from "node:assert";
/**
 * FilesDrawer integration test.
 *
 * Covers: open drawer → loads root entries; click directory → expands;
 * click file → preview popup opens with highlighted content. Uses vitest.
 * Mocks @tauri-apps/plugin-fs (+ stat size gate), @tauri-apps/plugin-opener,
 * and shiki (echoes code unhighlighted so token spans don't split assertions).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilesDrawer } from "../../src/components/FilesDrawer";
import * as useI18n from "../../src/i18n/useI18n";
import { queryWrapper } from "../helpers/queryWrapper";

// Mock @tauri-apps/plugin-fs
// The createFsClient wrapper normalises (cwd, rel) → absolute path via resolveFsPath,
// so we match on absolute paths.  cwd is "/proj" in this test.
vi.mock("@tauri-apps/plugin-fs", () => ({
    readDir: vi.fn(async (abs: string) => {
        if (abs === "/proj") {
            return [
                { name: "src", isDirectory: true },
                { name: "README.md", isDirectory: false },
            ];
        }
        if (abs === "/proj/src") {
            return [{ name: "index.ts", isDirectory: false }];
        }
        return [];
    }),
    readTextFile: vi.fn(async (abs: string) => {
        if (abs.endsWith("README.md")) return "Hello\nWorld";
        if (abs.endsWith("index.ts")) return "console.log('x')";
        throw new Error("not found");
    }),
    stat: vi.fn(async () => ({ size: 100 })),
    readFile: vi.fn(async () => new Uint8Array()),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
    revealItemInDir: vi.fn(async () => {}),
    openPath: vi.fn(async () => {}),
}));

// shiki's codeToHtml echoes the source wrapped in a .shiki pre — the test then
// asserts on visible text without depending on token-level span splits.
vi.mock("shiki", () => ({
    codeToHtml: vi.fn(async (code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
}));

// Mock useT
// useT() returns the raw { t: (key) => key } object from react-i18next.
// Mocking the module-level function (not the namespace) is the reliable approach.
vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

describe("FilesDrawer integration", () => {
    it("opens, loads root, expands a directory, selects a file", async () => {
        render(<FilesDrawer open={true} activeCwd="/proj" onClose={() => {}} />);

        // 1. root list loaded
        await waitFor(() => {
            assert.ok(screen.getByText("README.md"));
            assert.ok(screen.getByText("src"));
        });

        const user = userEvent.setup({ delay: null });

        // 2. expand src directory
        await user.click(screen.getByText("src"));
        await waitFor(() => {
            assert.ok(screen.getByText("index.ts"));
        });

        // 3. select index.ts → preview popup opens with the file content
        await user.click(screen.getByText("index.ts"));
        await waitFor(() => {
            assert.ok(screen.getByText("console.log('x')"));
        });
    });
});

afterEach(cleanup);
describe("FilesDrawer Git integration", () => {
    it("merges polled deleted files without reading them for preview", async () => {
        const client = {
            gitInspect: vi.fn().mockResolvedValue({
                status: "repository",
                repository: {
                    checkoutRoot: "/proj",
                    gitDir: "/proj/.git",
                    commonDir: "/proj/.git",
                    branch: "main",
                    headOid: null,
                    isBare: false,
                },
                changes: [
                    {
                        path: "src/deleted.ts",
                        kind: "deleted",
                        indexStatus: "D",
                        worktreeStatus: " ",
                    },
                ],
            }),
            gitInit: vi.fn(),
        };
        const { wrapper } = queryWrapper();
        render(<FilesDrawer client={client} open activeCwd="/proj" onClose={() => {}} />, {
            wrapper,
        });
        await waitFor(() => expect(client.gitInspect).toHaveBeenCalledWith({ workspace: "/proj" }));
        const user = userEvent.setup({ delay: null });
        await user.click(await screen.findByText("src"));
        const row = (await screen.findByText("deleted.ts")).closest(
            "[role=treeitem]",
        ) as HTMLElement;
        expect(row.getAttribute("aria-disabled")).toBe("true");
        await user.click(row);
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});

it("expands a fully deleted directory without attempting a filesystem read", async () => {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const client = {
        gitInspect: vi.fn().mockResolvedValue({
            status: "repository",
            repository: {
                checkoutRoot: "/proj",
                gitDir: "/proj/.git",
                commonDir: "/proj/.git",
                branch: "main",
                headOid: null,
                isBare: false,
            },
            changes: [
                {
                    path: "gone/deleted.ts",
                    kind: "deleted",
                    indexStatus: "D",
                    worktreeStatus: " ",
                },
            ],
        }),
        gitInit: vi.fn(),
    };
    render(<FilesDrawer client={client} open activeCwd="/proj" onClose={() => {}} />, {
        wrapper: queryWrapper().wrapper,
    });
    await userEvent.setup().click(await screen.findByText("gone"));
    expect(await screen.findByText("deleted.ts")).toBeTruthy();
    expect(readDir).not.toHaveBeenCalledWith("/proj/gone");
});

it("refreshes the filesystem snapshot on demand", async () => {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    render(<FilesDrawer open activeCwd="/proj" onClose={() => {}} />);
    await screen.findByText("README.md");
    const before = vi.mocked(readDir).mock.calls.length;
    await userEvent.setup().click(screen.getByRole("button", { name: "git.refreshFiles" }));
    await waitFor(() => expect(vi.mocked(readDir).mock.calls.length).toBeGreaterThan(before));
});

it("reads an existing directory even when its only changed file was deleted", async () => {
    const client = {
        gitInspect: vi.fn().mockResolvedValue({
            status: "repository",
            repository: {
                checkoutRoot: "/proj",
                gitDir: "/proj/.git",
                commonDir: "/proj/.git",
                branch: "main",
                headOid: null,
                isBare: false,
            },
            changes: [
                { path: "src/deleted.ts", kind: "deleted", indexStatus: "D", worktreeStatus: " " },
            ],
        }),
        gitInit: vi.fn(),
    };
    render(<FilesDrawer client={client} open activeCwd="/proj" onClose={() => {}} />, {
        wrapper: queryWrapper().wrapper,
    });
    await screen.findByText("README.md");
    await waitFor(() => expect(client.gitInspect).toHaveBeenCalled());
    await userEvent.setup().click(screen.getByText("src"));
    expect(await screen.findByText("index.ts")).toBeTruthy();
    expect(await screen.findByText("deleted.ts")).toBeTruthy();
});
