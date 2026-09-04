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
import userEvent from "@testing-library/user-event";
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

    it("offers a view toggle for mermaid blocks and flips it on click", async () => {
        const user = userEvent.setup();
        const { container } = render(
            <AssistantMarkdown text={"```mermaid\ngraph TD\n  A-->B\n```\n"} />,
        );

        // The toggle's presence/label depend only on the language tag, not on
        // whether mermaid can render in this environment (happy-dom render may
        // fail, which correctly falls back to the source view).
        const toggle = await screen.findByRole("button", { name: "View code" }, { timeout: 15000 });
        expect(screen.getByText("mermaid")).toBeTruthy();

        await user.click(toggle);
        expect(screen.getByRole("button", { name: "View diagram" })).toBeTruthy();
        // Toggling to source view must actually show the mermaid source, not
        // just flip the label — assert the fallback `<pre>` is present with
        // the raw diagram text.
        const pre = container.querySelector(".md-code-block pre");
        expect(pre).toBeTruthy();
        expect(pre?.textContent).toContain("graph TD");
        expect(pre?.textContent).toContain("A-->B");
        expect(container.querySelector(".md-mermaid")).toBeNull();

        await user.click(screen.getByRole("button", { name: "View diagram" }));
        expect(screen.getByRole("button", { name: "View code" })).toBeTruthy();
    });
});
