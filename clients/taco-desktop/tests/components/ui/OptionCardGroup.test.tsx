import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OptionCardGroup } from "../../../src/components/ui/OptionCardGroup";

afterEach(cleanup);

const items = [
    { value: "a", label: "Alpha", icon: <span>A</span> },
    { value: "b", label: "Beta", icon: <span>B</span>, description: "Second" },
    { value: "c", label: "Gamma", icon: <span>C</span> },
] as const;

function renderGroup(overrides: { disabled?: boolean } = {}) {
    const onValueChange = vi.fn();
    render(
        <OptionCardGroup
            label="Choice"
            value="a"
            items={items}
            onValueChange={onValueChange}
            {...overrides}
        />,
    );
    return onValueChange;
}

describe("OptionCardGroup", () => {
    it("selects on click and exposes radio state", async () => {
        const onValueChange = renderGroup();
        expect(screen.getByRole("radio", { name: "Alpha" }).getAttribute("aria-checked")).toBe(
            "true",
        );
        await userEvent.setup({ delay: null }).click(screen.getByRole("radio", { name: /Beta/ }));
        expect(onValueChange).toHaveBeenCalledWith("b");
    });

    it("moves focus and selection with arrows, Home, and End", async () => {
        const onValueChange = renderGroup();
        const user = userEvent.setup({ delay: null });
        const alpha = screen.getByRole("radio", { name: "Alpha" });
        alpha.focus();
        await user.keyboard("{ArrowLeft}");
        expect(onValueChange).toHaveBeenLastCalledWith("c");
        expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Gamma" }));
        await user.keyboard("{Home}");
        expect(onValueChange).toHaveBeenLastCalledWith("a");
        await user.keyboard("{End}");
        expect(onValueChange).toHaveBeenLastCalledWith("c");
    });

    it("does not change while disabled", async () => {
        const onValueChange = renderGroup({ disabled: true });
        const radio = screen.getByRole("radio", { name: "Alpha" });
        expect((radio as HTMLButtonElement).disabled).toBe(true);
        await userEvent.setup({ delay: null }).click(radio);
        expect(onValueChange).not.toHaveBeenCalled();
    });
});
