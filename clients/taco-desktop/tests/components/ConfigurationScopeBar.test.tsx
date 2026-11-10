import { strict as assert } from "node:assert";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import { ConfigurationScopeBar } from "../../src/components/ConfigurationScopeBar";

vi.mock("react-i18next", () => ({
    useTranslation: vi.fn(() => ({ t: (key: string) => key, i18n: { language: "en" } })),
}));

afterEach(cleanup);

const targets = [{ value: "/repo", label: "repo", detail: "/repo" }];

describe("ConfigurationScopeBar", () => {
    it("keeps scope tabs and target selection in the main content area", () => {
        const onScopeChange = vi.fn();
        const onTargetChange = vi.fn();
        render(
            <ConfigurationScopeBar
                variant="catalog"
                scope="workspace"
                onScopeChange={onScopeChange}
                targetCwd="/repo"
                targetOptions={targets}
                onTargetChange={onTargetChange}
            />,
        );
        assert.equal(screen.getAllByRole("tab").length, 4);
        assert.equal(
            screen
                .getByRole("tab", { name: /configScope.workspace/ })
                .getAttribute("aria-selected"),
            "true",
        );
        assert.ok(screen.getByRole("combobox", { name: "configScope.targetLabel" }));
        fireEvent.click(screen.getByRole("tab", { name: /configScope.global/ }));
        assert.deepEqual(onScopeChange.mock.calls, [["global"]]);
        const tablist = screen.getByRole("tablist");
        fireEvent.keyDown(tablist, { key: "ArrowRight" });
        assert.deepEqual(onScopeChange.mock.calls.at(-1), ["channel"]);
    });

    it("offers only real runtime targets for tools and explains missing channels", () => {
        const view = render(
            <ConfigurationScopeBar
                variant="runtime"
                scope="workspace"
                onScopeChange={() => {}}
                targetCwd="/repo"
                targetOptions={targets}
                onTargetChange={() => {}}
            />,
        );
        assert.equal(screen.getAllByRole("tab").length, 2);
        assert.equal(screen.queryByRole("tab", { name: /configScope.global/ }), null);
        view.rerender(
            <ConfigurationScopeBar
                variant="runtime"
                scope="channel"
                onScopeChange={() => {}}
                targetCwd={undefined}
                targetOptions={[]}
                onTargetChange={() => {}}
            />,
        );
        assert.ok(screen.getByText("configScope.noChannel"));
        assert.equal(screen.queryByRole("combobox"), null);
    });
});
