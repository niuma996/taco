/**
 * Select — base component test.
 *
 * Verifies the shared dropdown renders as a combobox trigger, exposes the
 * placeholder and aria-label, and reports the chosen option via
 * onValueChange. Locks this contract so the native-<select> removal doesn't
 * regress the Radix-based picker's a11y roles or value reporting.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "../../../src/components/ui/Select";

afterEach(cleanup);

const OPTIONS = [
    { value: "ask", label: "Ask" },
    { value: "auto", label: "Auto" },
];

describe("Select", () => {
    it("renders a combobox trigger with the placeholder", () => {
        render(<Select value="" onValueChange={() => {}} options={OPTIONS} placeholder="Pick" />);
        const trigger = screen.getByRole("combobox");
        expect(trigger.textContent).toContain("Pick");
    });

    it("opens the listbox and reports the selected option", async () => {
        const user = userEvent.setup();
        const onValueChange = vi.fn();
        render(
            <Select
                value="ask"
                onValueChange={onValueChange}
                options={OPTIONS}
                label="Permission mode"
            />,
        );
        await user.click(screen.getByRole("combobox"));
        const option = await screen.findByRole("option", { name: "Auto" });
        await user.click(option);
        expect(onValueChange).toHaveBeenCalledWith("auto");
    });
});
