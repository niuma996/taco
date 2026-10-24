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
 * Markdown renders synchronously, but the shared highlighter loads in the
 * background and blocks re-render once it is ready, so assertions on
 * highlighted output use waitFor.
 * Loading real grammars takes seconds under parallel load, which is more than
 * vitest's 5s default — without the explicit test timeout below the per-assertion
 * waitFor budgets could never actually be spent, and these tests failed
 * intermittently depending on what else was running.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AssistantMarkdown } from "../../src/components/AssistantMarkdown";

/** Must exceed the 15s waitFor budgets used in each test below. */
const SHIKI_TEST_TIMEOUT_MS = 20_000;

afterEach(cleanup);

describe("AssistantMarkdown first paint", () => {
    it("renders its content synchronously, before any highlighting", () => {
        // A message that mounts empty and fills in later grows the
        // conversation after the scroll-to-bottom ran — the open-session jump.
        const { container } = render(
            <AssistantMarkdown text={"Hello **world**\n\n```python\nprint(1)\n```\n"} />,
        );
        expect(container.querySelector("strong")?.textContent).toBe("world");
        expect(container.querySelector(".md-code-block pre")?.textContent).toContain("print(1)");
        expect(screen.getByText("python")).toBeTruthy();
    });

    it(
        "keeps the code block mounted when highlighting lands",
        async () => {
            const user = userEvent.setup();
            const { container } = render(
                <AssistantMarkdown text={"```mermaid\ngraph TD\n  A-->B\n```\n"} />,
            );
            // Flip to source before the highlighter is ready; a remount on
            // highlight would reset the toggle back to the diagram view.
            await user.click(screen.getByRole("button", { name: "View code" }));
            await waitFor(
                () => {
                    expect(container.querySelector(".md-code-block pre.shiki")).toBeTruthy();
                },
                { timeout: 15000 },
            );
            expect(screen.getByRole("button", { name: "View diagram" })).toBeTruthy();
        },
        SHIKI_TEST_TIMEOUT_MS,
    );
});

describe("AssistantMarkdown code blocks", () => {
    it(
        "renders the fenced block's language in the header",
        async () => {
            render(<AssistantMarkdown text={"```python\nprint(1)\n```\n"} />);
            await waitFor(
                () => {
                    expect(screen.getByText("python")).toBeTruthy();
                },
                { timeout: 15000 },
            );
        },
        SHIKI_TEST_TIMEOUT_MS,
    );

    it(
        "falls back to a generic label for blocks without a language",
        async () => {
            render(<AssistantMarkdown text={"```\nplain\n```\n"} />);
            await waitFor(
                () => {
                    expect(screen.getByText("code")).toBeTruthy();
                },
                { timeout: 15000 },
            );
        },
        SHIKI_TEST_TIMEOUT_MS,
    );

    it(
        "offers a view toggle for mermaid blocks and flips it on click",
        async () => {
            const user = userEvent.setup();
            const { container } = render(
                <AssistantMarkdown text={"```mermaid\ngraph TD\n  A-->B\n```\n"} />,
            );

            // The toggle's presence/label depend only on the language tag, not on
            // whether mermaid can render in this environment (happy-dom render may
            // fail, which correctly falls back to the source view).
            const toggle = await screen.findByRole(
                "button",
                { name: "View code" },
                { timeout: 15000 },
            );
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
        },
        SHIKI_TEST_TIMEOUT_MS,
    );

    it(
        "renders Mermaid syntax through Pele as a themed SVG",
        async () => {
            const { container } = render(
                <AssistantMarkdown text={"```mermaid\nflowchart LR\n  A --> B\n```\n"} />,
            );

            await waitFor(
                () => {
                    const svg = container.querySelector(".md-mermaid svg");
                    expect(svg).toBeTruthy();
                    expect(svg?.classList.contains("pele")).toBe(true);
                },
                { timeout: 15000 },
            );
        },
        SHIKI_TEST_TIMEOUT_MS,
    );

    it(
        "renders a diagram in its first paint once Pele is loaded",
        async () => {
            // Load Pele through a first diagram, then mount a second one: it
            // must paint as an SVG straight away, not as source that later
            // grows into a diagram and shoves the text below it.
            const first = render(
                <AssistantMarkdown text={"```mermaid\nflowchart LR\n  A --> B\n```\n"} />,
            );
            await waitFor(
                () => {
                    expect(first.container.querySelector(".md-mermaid svg")).toBeTruthy();
                },
                { timeout: 15000 },
            );
            first.unmount();

            const { container } = render(
                <AssistantMarkdown
                    text={"Before\n\n```mermaid\nflowchart LR\n  C --> D\n```\n\nAfter\n"}
                />,
            );
            expect(container.querySelector(".md-mermaid svg")).toBeTruthy();
            expect(container.querySelector(".md-mermaid")?.textContent).toContain("C");
        },
        SHIKI_TEST_TIMEOUT_MS,
    );

    it(
        "keeps generic labels like List<T> instead of dropping the parameter",
        async () => {
            const { container } = render(
                <AssistantMarkdown text={"```mermaid\nflowchart LR\n  A[List<T>] --> B\n```\n"} />,
            );

            await waitFor(
                () => {
                    const svg = container.querySelector(".md-mermaid svg");
                    expect(svg).toBeTruthy();
                    expect(svg?.textContent).toContain("List<T>");
                },
                { timeout: 15000 },
            );
        },
        SHIKI_TEST_TIMEOUT_MS,
    );
});
