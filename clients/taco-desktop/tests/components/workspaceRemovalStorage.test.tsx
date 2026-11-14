import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type DesktopConfig,
    readDesktopConfig,
    writeDesktopConfig,
} from "../../src/lib/desktopConfig";
import {
    persistActiveCwd,
    persistExpandedWorkspaces,
    persistWorkspaceRemoval,
    pruneMissingCwds,
} from "../../src/lib/workspaceStorage";

vi.mock("../../src/lib/desktopConfig", () => ({
    readDesktopConfig: vi.fn(),
    writeDesktopConfig: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("workspace removal persistence", () => {
    it("removes only the selected path and expansion while preserving other workspace preferences", async () => {
        vi.mocked(readDesktopConfig).mockResolvedValue({
            workspaces: {
                opened: ["/a", "/b"],
                active: "/a",
                expanded: ["/a", "/b"],
            },
        });
        await persistWorkspaceRemoval("/a", "/b");
        const patch = vi.mocked(writeDesktopConfig).mock.calls.at(-1)?.[0];
        expect(typeof patch).toBe("function");
        expect(typeof patch === "function" ? patch(await readDesktopConfig()) : patch).toEqual({
            workspaces: {
                opened: ["/b"],
                active: "/b",
                expanded: ["/b"],
                emptyAllowed: true,
            },
        });
    });
    it("persists an intentionally empty list without seeding the default directory", async () => {
        vi.mocked(readDesktopConfig).mockResolvedValue({
            workspaces: {
                opened: [],
                active: "",
                emptyAllowed: true,
            },
        });
        expect(await pruneMissingCwds([])).toEqual([]);
    });
    it("propagates storage errors so removal can be retried", async () => {
        vi.mocked(readDesktopConfig).mockResolvedValue({
            workspaces: { opened: ["/a"], active: "/a" },
        });
        vi.mocked(writeDesktopConfig).mockRejectedValueOnce(new Error("disk full"));
        await expect(persistWorkspaceRemoval("/a", "")).rejects.toThrow("disk full");
    });
});

it.each([
    ["missing workspace preferences", {}],
    ["missing opened list", { workspaces: {} }],
    ["null opened list", { workspaces: { opened: null } }],
    ["string opened list", { workspaces: { opened: "/a" } }],
    ["object opened list", { workspaces: { opened: {} } }],
    ["numeric opened list", { workspaces: { opened: 1 } }],
])("persists empty expansion for %s", async (_label, config) => {
    await persistExpandedWorkspaces(["/a"]);
    const patch = vi.mocked(writeDesktopConfig).mock.calls.at(-1)?.[0];
    expect(typeof patch).toBe("function");
    if (typeof patch !== "function") throw new Error("Expected a functional config patch");
    expect(patch(config as unknown as DesktopConfig)).toEqual({
        workspaces: { opened: [], active: "", expanded: [] },
    });
});

it("merges delayed expansion and active writes against the latest removal", async () => {
    const initial = { workspaces: { opened: ["/a", "/b"], active: "/a", expanded: ["/a"] } };
    vi.mocked(readDesktopConfig).mockResolvedValue(initial);
    await persistExpandedWorkspaces(["/a", "/b"]);
    const expansion = vi.mocked(writeDesktopConfig).mock.calls.at(-1)?.[0];
    await persistActiveCwd("/a");
    const selection = vi.mocked(writeDesktopConfig).mock.calls.at(-1)?.[0];
    const latest = {
        workspaces: { opened: ["/b"], active: "/b", expanded: [], emptyAllowed: true },
    };
    expect(typeof expansion === "function" ? expansion(latest) : expansion).toEqual({
        workspaces: {
            ...latest.workspaces,
            expanded: ["/b"],
        },
    });
    expect(typeof selection === "function" ? selection(latest) : selection).toEqual({
        workspaces: latest.workspaces,
    });
});
