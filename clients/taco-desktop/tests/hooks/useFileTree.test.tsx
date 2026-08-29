import { strict as assert } from "node:assert";
/**
 * useFileTree tests — mock fsClient, no React render dependency.
 * Uses renderHook (@testing-library/react) to drive the hook.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, it, vi } from "vitest";

import { useFileTree } from "../../src/hooks/useFileTree";
import type { FsClient } from "../../src/lib/clients/fsClient";
import type { FileEntry } from "../../src/lib/fileTypes";

function makeApi(map: Record<string, FileEntry[]>): FsClient {
    return {
        readDir: vi.fn(async (rel: string) => map[rel] ?? []),
        readText: vi.fn(async () => ""),
    };
}

const rootEntries: FileEntry[] = [
    { relPath: "src", name: "src", kind: "dir", size: -1 },
    { relPath: "README.md", name: "README.md", kind: "file", size: 100 },
    { relPath: "node_modules", name: "node_modules", kind: "dir", size: -1 },
    { relPath: ".env", name: ".env", kind: "file", size: 10 },
];

describe("useFileTree.loadRoot", () => {
    it("loads root entries, filters ALWAYS_HIDE_NAMES + dotfiles, sorts dirs first", async () => {
        const api = makeApi({ "": rootEntries });
        const { result } = renderHook(() => useFileTree(api));

        await act(async () => {
            await result.current.loadRoot();
        });

        const root = result.current.entriesByDir.get("");
        assert.ok(root, "root should be set");
        assert.deepEqual(
            root?.map((e) => e.name),
            ["src", "README.md"], // node_modules and dotfiles filtered
        );
    });

    it("set error message when fsClient throws", async () => {
        const api: FsClient = {
            readDir: vi.fn(async () => {
                throw new Error("EACCES");
            }),
            readText: vi.fn(async () => ""),
        };
        const { result } = renderHook(() => useFileTree(api));

        await act(async () => {
            await result.current.loadRoot();
        });

        assert.match(result.current.error ?? "", /EACCES/);
    });
});

describe("useFileTree.toggleExpand", () => {
    it("expands a directory (cache miss → fetch + cache)", async () => {
        const api = makeApi({
            "": rootEntries,
            src: [{ relPath: "src/index.ts", name: "index.ts", kind: "file", size: 50 }],
        });
        const { result } = renderHook(() => useFileTree(api));

        await act(async () => {
            await result.current.loadRoot();
        });

        await act(async () => {
            await result.current.toggleExpand("src");
        });

        assert.ok(result.current.expanded.has("src"));
        assert.ok(result.current.entriesByDir.has("src"));
    });

    it("collapses a directory without re-fetching", async () => {
        const api = makeApi({
            "": rootEntries,
            src: [{ relPath: "src/index.ts", name: "index.ts", kind: "file", size: 50 }],
        });
        const { result } = renderHook(() => useFileTree(api));

        await act(async () => {
            await result.current.loadRoot();
        });

        await act(async () => {
            await result.current.toggleExpand("src"); // expand
        });

        await act(async () => {
            await result.current.toggleExpand("src"); // collapse
        });

        assert.ok(!result.current.expanded.has("src"));
        // entriesByDir is still cached — collapse ≠ delete
        assert.ok(result.current.entriesByDir.has("src"));
    });
});

describe("useFileTree.refresh", () => {
    it("clears cached entries and reloads root", async () => {
        const api = makeApi({
            "": rootEntries,
            src: [{ relPath: "src/index.ts", name: "index.ts", kind: "file", size: 50 }],
        });
        const { result } = renderHook(() => useFileTree(api));

        await act(async () => {
            await result.current.loadRoot();
            await result.current.toggleExpand("src");
        });
        assert.ok(result.current.entriesByDir.has("src"));

        await act(async () => {
            await result.current.refresh();
        });

        assert.ok(!result.current.entriesByDir.has("src"));
        assert.ok(!result.current.expanded.has("src"));
        assert.ok(result.current.entriesByDir.has(""));
    });
});

describe("useFileTree.showHidden", () => {
    it("when toggled on, refreshes root and includes dotfiles", async () => {
        const api = makeApi({ "": rootEntries });
        const { result } = renderHook(() => useFileTree(api));

        await act(async () => {
            await result.current.loadRoot();
        });

        await act(async () => {
            await result.current.setShowHidden(true);
        });

        await waitFor(() => {
            const root = result.current.entriesByDir.get("");
            assert.ok(root, "root should be set after setShowHidden");
            assert.ok(root?.some((e) => e.name === ".env"));
        });
        // node_modules still filtered (ALWAYS_HIDE_NAMES takes precedence over showHidden)
        const root = result.current.entriesByDir.get("");
        assert.ok(root);
        assert.ok(!root?.some((e) => e.name === "node_modules"));
    });
});
