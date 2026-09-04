/**
 * AssistantMarkdown — code-block header integration test.
 *
 * Locks the full react-markdown → `@shikijs/rehype` → `CodeBlockWithCopy`
 * pipeline: a fenced block's language must survive shiki's replacement of
 * the original `<pre>` and reach the header. A previous implementation set
 * the language from a rehype plugin running *before* shiki — the node it
 * tagged was discarded, the label silently stayed "code", and unit tests
 * of that plugin alone could not see the break. Only an end-to-end render
 * covers it.
 *
 * Shiki highlighting is async (`MarkdownHooks`), so assertions use waitFor.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AssistantMarkdown } from "../../src/components/AssistantMarkdown";

afterEach(cleanup);

describe("AssistantMarkdown code blocks", () => {
    it("renders the fenced block's language in the header", async () => {
        render(<AssistantMarkdown text={"```python\nprint(1)\n```\n"} />);
        await waitFor(
            () => {
                expect(screen.getByText("python")).toBeTruthy();
            },
            { timeout: 15000 },
        );
    });

    it("falls back to a generic label for blocks without a language", async () => {
        render(<AssistantMarkdown text={"```\nplain\n```\n"} />);
        await waitFor(
            () => {
                expect(screen.getByText("code")).toBeTruthy();
            },
            { timeout: 15000 },
        );
    });
});
