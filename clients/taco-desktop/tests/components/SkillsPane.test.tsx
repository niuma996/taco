import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import { SkillsPane, type SkillsPaneProps } from "../../src/views/SkillsPane";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({ t: (key: string) => key, i18n: { language: "en" } })),
}));

afterEach(cleanup);

const props: SkillsPaneProps = {
    skills: [
        {
            name: "review",
            description: "Review changes carefully",
            source: "builtin",
            filePath: "/skills/review/SKILL.md",
        },
        {
            name: "release",
            description: "Prepare a release",
            source: "user",
            filePath: "/skills/release/SKILL.md",
        },
    ],
    totalCount: 2,
    skillsError: null,
    query: "",
    onQueryChange: () => {},
    diagnostics: [],
    selectedName: "review",
    onSelect: () => {},
    content:
        "---\nname: review\ndescription: metadata only\n---\n# Instructions\n\nKeep this **body** intact.",
    contentLoading: false,
    contentError: null,
};

describe("SkillsPane", () => {
    it("previews descriptions on selectable cards and preserves the Markdown detail", () => {
        const onSelect = vi.fn();
        render(<SkillsPane {...props} onSelect={onSelect} />);
        const card = screen.getByRole("button", { name: /review Review changes carefully/ });
        assert.ok(within(card).getByText("activity.skillsSourceBuiltin"));
        assert.equal(card.getAttribute("aria-current"), "true");
        fireEvent.click(screen.getByRole("button", { name: /release Prepare a release/ }));
        assert.deepEqual(onSelect.mock.calls, [["release"]]);
        assert.ok(screen.getByRole("heading", { name: "Instructions", level: 1 }));
        assert.ok(screen.getByText("body", { selector: "strong" }));
        assert.equal(screen.queryByText(/metadata only/), null);
        assert.ok(screen.getByText("/skills/review/SKILL.md"));
    });

    it("keeps problems and same-name overrides separate from skill selection", () => {
        render(
            <SkillsPane
                {...props}
                diagnostics={[
                    { code: "parse_failed", path: "/broken/SKILL.md", message: "Invalid metadata" },
                    {
                        code: "duplicate_name",
                        path: "/shadowed/SKILL.md",
                        message: "Overridden skill",
                    },
                ]}
            />,
        );
        assert.equal(screen.getAllByRole("status").length, 2);
        assert.ok(screen.getByText("Invalid metadata"));
        assert.ok(screen.getByText("activity.skillsDiagnosticsOverrideTitle"));
        assert.equal(screen.queryByText("Overridden skill"), null);
        assert.ok(screen.getByRole("button", { name: /release/ }));
    });

    it("uses the existing controlled search and distinguishes no results from no skills", () => {
        const onQueryChange = vi.fn();
        const view = render(<SkillsPane {...props} onQueryChange={onQueryChange} />);
        fireEvent.click(screen.getByRole("button", { name: "pane.searchLabel" }));
        fireEvent.change(screen.getByRole("textbox", { name: "pane.searchLabel" }), {
            target: { value: "missing" },
        });
        assert.deepEqual(onQueryChange.mock.calls, [["missing"]]);
        view.rerender(<SkillsPane {...props} skills={[]} query="missing" />);
        assert.ok(screen.getByText("activity.skillsNoMatch"));
        assert.equal(screen.queryByText("activity.skillsEmptyState"), null);
        view.rerender(<SkillsPane {...props} skills={[]} query="" />);
        assert.ok(screen.getByText(/activity.skillsEmptyState/));
    });

    it("preserves loading, error, and model visibility states", () => {
        const view = render(
            <SkillsPane
                {...props}
                skills={props.skills.map((skill) => ({ ...skill, disableModelInvocation: true }))}
                contentLoading
            />,
        );
        assert.ok(screen.getByText("activity.contentNotEditable"));
        assert.ok(screen.getByText("activity.loading"));
        view.rerender(<SkillsPane {...props} contentError="Could not read skill" />);
        assert.equal(screen.getByRole("alert").textContent, "Could not read skill");
        assert.equal(screen.queryByRole("heading", { name: "Instructions" }), null);
    });
});
