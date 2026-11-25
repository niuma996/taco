import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { DesktopConfig } from "../../src/lib/desktopConfig";

type ConfigPatch = (current: DesktopConfig) => Partial<DesktopConfig>;

const readDesktopConfig = mock.fn(async (): Promise<DesktopConfig> => ({}));
const writeDesktopConfig = mock.fn(
    async (_patch: ConfigPatch | Partial<DesktopConfig>): Promise<void> => {},
);
const invoke = mock.fn(async (): Promise<unknown> => undefined);

mock.module("../../src/lib/desktopConfig.ts", {
    namedExports: { readDesktopConfig, writeDesktopConfig },
});
mock.module("@tauri-apps/api/core", { namedExports: { invoke } });

const { persistActiveCwd, persistExpandedWorkspaces, persistWorkspaceRemoval, pruneMissingCwds } =
    await import("../../src/lib/workspaceStorage.ts");

afterEach(() => {
    readDesktopConfig.mock.resetCalls();
    writeDesktopConfig.mock.resetCalls();
    invoke.mock.resetCalls();
});

describe("workspace removal persistence", () => {
    it("removes only the selected path and expansion while preserving other workspace preferences", async () => {
        readDesktopConfig.mock.mockImplementation(async () => ({
            workspaces: {
                opened: ["/a", "/b"],
                active: "/a",
                expanded: ["/a", "/b"],
            },
        }));
        await persistWorkspaceRemoval("/a", "/b");
        const patch = writeDesktopConfig.mock.calls.at(-1)?.arguments[0];
        assert.equal(typeof patch, "function");
        assert.deepStrictEqual(
            typeof patch === "function" ? patch(await readDesktopConfig()) : patch,
            {
                workspaces: {
                    opened: ["/b"],
                    active: "/b",
                    expanded: ["/b"],
                    emptyAllowed: true,
                },
            },
        );
    });
    it("persists an intentionally empty list without seeding the default directory", async () => {
        readDesktopConfig.mock.mockImplementation(async () => ({
            workspaces: {
                opened: [],
                active: "",
                emptyAllowed: true,
            },
        }));
        assert.deepStrictEqual(await pruneMissingCwds([]), []);
    });
    it("propagates storage errors so removal can be retried", async () => {
        readDesktopConfig.mock.mockImplementation(async () => ({
            workspaces: { opened: ["/a"], active: "/a" },
        }));
        writeDesktopConfig.mock.mockImplementationOnce(async () => {
            throw new Error("disk full");
        });
        await assert.rejects(persistWorkspaceRemoval("/a", ""), /disk full/);
    });
});

for (const [label, config] of [
    ["missing workspace preferences", {}],
    ["missing opened list", { workspaces: {} }],
    ["null opened list", { workspaces: { opened: null } }],
    ["string opened list", { workspaces: { opened: "/a" } }],
    ["object opened list", { workspaces: { opened: {} } }],
    ["numeric opened list", { workspaces: { opened: 1 } }],
] as const) {
    it(`persists empty expansion for ${label}`, async () => {
        await persistExpandedWorkspaces(["/a"]);
        const patch = writeDesktopConfig.mock.calls.at(-1)?.arguments[0];
        assert.equal(typeof patch, "function");
        if (typeof patch !== "function") throw new Error("Expected a functional config patch");
        assert.deepStrictEqual(patch(config as unknown as DesktopConfig), {
            workspaces: { opened: [], active: "", expanded: [] },
        });
    });
}

it("merges delayed expansion and active writes against the latest removal", async () => {
    const initial = { workspaces: { opened: ["/a", "/b"], active: "/a", expanded: ["/a"] } };
    readDesktopConfig.mock.mockImplementation(async () => initial);
    await persistExpandedWorkspaces(["/a", "/b"]);
    const expansion = writeDesktopConfig.mock.calls.at(-1)?.arguments[0];
    await persistActiveCwd("/a");
    const selection = writeDesktopConfig.mock.calls.at(-1)?.arguments[0];
    const latest = {
        workspaces: { opened: ["/b"], active: "/b", expanded: [], emptyAllowed: true },
    };
    assert.deepStrictEqual(typeof expansion === "function" ? expansion(latest) : expansion, {
        workspaces: { ...latest.workspaces, expanded: ["/b"] },
    });
    assert.deepStrictEqual(typeof selection === "function" ? selection(latest) : selection, {
        workspaces: latest.workspaces,
    });
});
