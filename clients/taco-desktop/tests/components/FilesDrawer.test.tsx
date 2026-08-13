import { strict as assert } from "node:assert";
/**
 * FilesDrawer integration test.
 *
 * Covers: open drawer → loads root entries; click directory → expands;
 * click file → preview pane shows content. Uses vitest. Mocks
 * @tauri-apps/plugin-fs and useT.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, vi } from "vitest";

import { FilesDrawer } from "../../src/components/FilesDrawer";
import * as useI18n from "../../src/i18n/useI18n";

// Mock @tauri-apps/plugin-fs
// The createFsApi wrapper normalises (cwd, rel) → absolute path via resolveFsPath,
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

        const user = userEvent.setup();

        // 2. expand src directory
        await user.click(screen.getByText("src"));
        await waitFor(() => {
            assert.ok(screen.getByText("index.ts"));
        });

        // 3. select README.md → preview pane shows content
        await user.click(screen.getByText("README.md"));
        await waitFor(() => {
            assert.ok(screen.getByText("Hello"));
            assert.ok(screen.getByText("World"));
        });
    });
});
