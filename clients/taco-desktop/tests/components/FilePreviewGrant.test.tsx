import { strict as assert } from "node:assert";
/**
 * Temporary FS-scope grant flow, end to end through the popup.
 *
 * A path outside the FS scope makes tauri-plugin-fs reject with the bare
 * string "forbidden path: …". The popup must offer a grant button rather than
 * an empty body, and clicking it must invoke `allow_fs_file` for that one file
 * and then re-read it.
 *
 * `scopeAllows` stands in for the Rust-side scope: flipped by the mocked
 * `allow_fs_file`, so the retry read only succeeds because the grant landed.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { FilePreviewPopup } from "../../src/components/FilePreviewPopup";
import { useFilePreview } from "../../src/hooks/useFilePreview";
import * as useI18n from "../../src/i18n/useI18n";
import { createFsClient } from "../../src/lib/clients/fsClient";

const OUT_OF_SCOPE = "/Users/x/.taco/sessions/s1/subagent-results/a.md";

let scopeAllows = false;
const invoked: Array<{ cmd: string; args: unknown }> = [];

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string, args: unknown) => {
        invoked.push({ cmd, args });
        if (cmd === "allow_fs_file") scopeAllows = true;
    }),
    convertFileSrc: (p: string) => p,
}));

// Both stat and readTextFile go through the scope, so both must refuse while
// the grant is missing — matching the plugin's own Error::PathForbidden text.
vi.mock("@tauri-apps/plugin-fs", () => ({
    stat: vi.fn(async (abs: string) => {
        if (!scopeAllows) throw `forbidden path: ${abs}`;
        return { size: 42 };
    }),
    readTextFile: vi.fn(async (abs: string) => {
        if (!scopeAllows) throw `forbidden path: ${abs}`;
        return "# recovered result";
    }),
    readDir: vi.fn(async () => []),
    readFile: vi.fn(async () => new Uint8Array()),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
    revealItemInDir: vi.fn(async () => {}),
    openPath: vi.fn(async () => {}),
}));

vi.mock("shiki", () => ({
    codeToHtml: vi.fn(async (code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
}));

// The retry renders the file as markdown through AssistantMarkdown. The shiki
// mock above has no createHighlighter, so its highlighter never loads and the
// markdown renders plain — no grammar load. Real highlighting is covered by
// AssistantMarkdown.test.tsx.

vi.spyOn(useI18n, "useT").mockReturnValue({
    t: (key: string) => key,
} as unknown as ReturnType<typeof useI18n.useT>);

/** Drives the popup the way FilePreviewOpenerProvider does. */
function Harness({ path }: { path: string }) {
    const preview = useFilePreview(createFsClient("/proj"));
    return (
        <>
            <button type="button" onClick={() => void preview.select(path)}>
                open
            </button>
            <FilePreviewPopup preview={preview} cwd="/proj" />
        </>
    );
}

beforeEach(() => {
    scopeAllows = false;
    invoked.length = 0;
});

afterEach(cleanup);

describe("file preview — temporary FS scope grant", () => {
    it("offers a grant instead of a blank body when the path is out of scope", async () => {
        const user = userEvent.setup();
        render(<Harness path={OUT_OF_SCOPE} />);
        await user.click(screen.getByText("open"));

        await waitFor(() => {
            assert.ok(screen.getByText("files.forbiddenTitle"));
        });
        // The raw plugin error must not be what the user reads.
        assert.equal(screen.queryByText(/forbidden path/), null);
        assert.ok(screen.getByText("files.grantAccess"));
    });

    it("grants that one file, then renders the content on retry", async () => {
        const user = userEvent.setup();
        render(<Harness path={OUT_OF_SCOPE} />);
        await user.click(screen.getByText("open"));
        await waitFor(() => {
            assert.ok(screen.getByText("files.grantAccess"));
        });

        await user.click(screen.getByText("files.grantAccess"));

        // Rendered as markdown, so the leading "#" becomes a heading.
        await waitFor(() => {
            assert.ok(screen.getByRole("heading", { name: "recovered result" }));
        });
        assert.equal(screen.queryByText("files.forbiddenTitle"), null);

        const grants = invoked.filter((c) => c.cmd === "allow_fs_file");
        assert.equal(grants.length, 1);
        // File-granular: the exact path, never the directory around it.
        assert.deepEqual(grants[0].args, { path: OUT_OF_SCOPE });
        assert.equal(
            invoked.some((c) => c.cmd === "set_fs_scope"),
            false,
        );
    });

    it("shows the plain error, with no grant button, for an ordinary IO failure", async () => {
        const fs = await import("@tauri-apps/plugin-fs");
        vi.mocked(fs.stat).mockImplementationOnce(async () => {
            throw new Error("ENOENT: no such file");
        });

        const user = userEvent.setup();
        render(<Harness path="/proj/gone.md" />);
        await user.click(screen.getByText("open"));

        await waitFor(() => {
            assert.ok(screen.getByText(/ENOENT/));
        });
        assert.equal(screen.queryByText("files.grantAccess"), null);
    });
});
