import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import { ToolsPane } from "../../src/views/ToolsPane";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({ t: (key: string) => key, i18n: { language: "en" } })),
}));

afterEach(cleanup);

describe("ToolsPane", () => {
    it("keeps tool selection and source filtering available in the compact list", () => {
        const { container } = render(
            <ToolsPane
                error={null}
                tools={[
                    {
                        name: "read_file",
                        label: "Read file",
                        description: "Read a workspace file.",
                        category: "builtin",
                        inputSchema: { type: "object" },
                    },
                    {
                        name: "web_search",
                        label: "Web search",
                        description: "Search the web.",
                        category: "mcp",
                        loading: "deferred",
                    },
                ]}
            />,
        );

        assert.ok(container.querySelector(".tools-list > .pane-header .pane-search"));
        assert.equal(container.querySelectorAll(".tools-filter-chips").length, 3);
        assert.equal(
            container.querySelector(".tools-filter-label")?.textContent,
            "tools.filterSource",
        );
        assert.equal(container.querySelectorAll(".tools-filter .ui-select-trigger").length, 0);
        assert.ok(container.querySelector(".tools-list-item-description"));
        assert.ok(container.querySelector(".tools-detail-schema--fill"));
        assert.equal(
            container.querySelector(".tools-list-item-description")?.textContent,
            "Read a workspace file.",
        );

        fireEvent.click(screen.getByRole("button", { name: /Web search/ }));
        assert.ok(screen.getByRole("heading", { name: "web_search" }));
        assert.equal(
            screen.getByRole("button", { name: /Web search/ }).getAttribute("aria-current"),
            "true",
        );

        const sourceFilter = screen.getByRole("radiogroup", { name: "tools.filterSource" });
        fireEvent.keyDown(sourceFilter, { key: "ArrowRight" });
        assert.equal(
            screen
                .getByRole("radio", { name: "tools.categoryBuiltin" })
                .getAttribute("aria-checked"),
            "true",
        );
    });
});
