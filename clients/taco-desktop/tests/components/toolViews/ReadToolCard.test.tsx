/**
 * read tool card integration test.
 *
 * Covers: a successful read shows the line count instead of the file body; the
 * content button opens the shared preview popup with the file's real content;
 * a failed read still shows the raw error text.
 */
import { strict as assert } from "node:assert";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, vi } from "vitest";

import { ToolCardShell } from "../../../src/components/ToolCardShell";
import "../../../src/components/toolViews/index.ts";
import { FilePreviewOpenerProvider } from "../../../src/hooks/useFilePreviewOpener";
import * as useI18n from "../../../src/i18n/useI18n";
import type { UiToolCall } from "../../../src/lib/chat/chatUtils";

vi.mock("@tauri-apps/plugin-fs", () => ({
    readDir: vi.fn(async () => []),
    readTextFile: vi.fn(async (abs: string) => {
        if (abs === "/proj/src/index.ts") return "console.log('x')";
        throw new Error("not found");
    }),
    stat: vi.fn(async () => ({ size: 100 })),
    readFile: vi.fn(async () => new Uint8Array()),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
    revealItemInDir: vi.fn(async () => {}),
}));

vi.mock("shiki", () => ({
    codeToHtml: vi.fn(async (code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
}));

// t() echoes the key plus the interpolated count so assertions stay locale-free.
vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string, opts?: { count?: number }) =>
        opts?.count === undefined ? key : `${key}:${opts.count}`,
} as unknown as ReturnType<typeof useI18n.useT>);

function readTool(overrides: Partial<UiToolCall> = {}): UiToolCall {
    return {
        id: "call-1",
        name: "read",
        args: { path: "src/index.ts" },
        status: "ok",
        resultText: "console.log('x')",
        ...overrides,
    };
}

// The shell resolves read's body from the registry, so the view is not passed
// in — importing the entry point is what wires it up.
function renderCard(tool: UiToolCall) {
    return render(
        <FilePreviewOpenerProvider cwd="/proj">
            <ToolCardShell tool={tool} />
        </FilePreviewOpenerProvider>,
    );
}

describe("read tool card", () => {
    afterEach(cleanup);

    it("shows the line count and hides the file body", () => {
        renderCard(readTool({ resultText: "a\nb\nc" }));

        assert.ok(screen.getByText("activity.readLines:3"));
        assert.equal(screen.queryByText("a\nb\nc"), null);
    });

    it("opens the preview popup with the file content", async () => {
        renderCard(readTool());

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "activity.readOpenFile" }));

        await waitFor(() => {
            assert.ok(screen.getByText("console.log('x')"));
        });
    });

    it("keeps the raw text on a failed read", () => {
        renderCard(readTool({ status: "error", resultText: "ENOENT: no such file or directory" }));

        assert.ok(screen.getByText("ENOENT: no such file or directory"));
        assert.equal(screen.queryByRole("button", { name: "activity.readOpenFile" }), null);
    });

    // expireUnresolvedToolCalls marks a card errored without a resultText.
    it("renders no body for an errored card with no result text", () => {
        const { container } = renderCard(readTool({ status: "error", resultText: undefined }));

        assert.equal(container.querySelector(".tool-card-result"), null);
        assert.equal(screen.queryByRole("button", { name: "activity.readOpenFile" }), null);
    });
});
