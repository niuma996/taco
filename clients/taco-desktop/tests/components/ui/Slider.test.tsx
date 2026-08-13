/**
 * Slider — base component test.
 *
 * Locks the discrete-step contract (value snaps to step, arrow keys step,
 * release fires onValueCommit) so the migration from the hand-rolled
 * ThinkingSlider and native <input type="range"> doesn't regress the
 * value reporting or commit semantics.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Slider } from "../../../src/components/ui/Slider";

afterEach(cleanup);

describe("Slider", () => {
    it("renders a slider with the expected value and min/max", () => {
        render(<Slider value={3} min={0} max={6} step={1} ariaLabel="Level" />);
        const slider = screen.getByRole("slider", { name: "Level" });
        expect(slider.getAttribute("aria-valuenow")).toBe("3");
        expect(slider.getAttribute("aria-valuemin")).toBe("0");
        expect(slider.getAttribute("aria-valuemax")).toBe("6");
    });

    it("steps by the step amount on ArrowRight and reports via onValueChange", async () => {
        const user = userEvent.setup();
        const onValueChange = vi.fn();
        render(
            <Slider
                value={3}
                min={0}
                max={6}
                step={1}
                ariaLabel="Level"
                onValueChange={onValueChange}
            />,
        );
        const slider = screen.getByRole("slider", { name: "Level" });
        await user.click(slider);
        await user.keyboard("{ArrowRight}");
        expect(onValueChange).toHaveBeenCalledWith(4);
    });

    it("commits the final value via onValueCommit on keyboard release", async () => {
        const user = userEvent.setup();
        const onValueCommit = vi.fn();
        render(
            <Slider
                value={3}
                min={0}
                max={6}
                step={1}
                ariaLabel="Level"
                onValueCommit={onValueCommit}
            />,
        );
        const slider = screen.getByRole("slider", { name: "Level" });
        await user.click(slider);
        await user.keyboard("{ArrowRight}");
        expect(onValueCommit).toHaveBeenCalledWith(4);
    });

    it("renders marks in a decorative overlay, leaving their percent untouched", () => {
        // Alignment with the thumb is purely geometric: the .ui-slider-marks
        // layer is inset by half a thumb width in CSS, which reproduces the
        // thumb's own track. So a mark keeps the plain `left: <pct>%` the
        // caller gave it — no inline recalculation.
        render(
            <Slider
                value={0}
                min={0}
                max={6}
                step={1}
                ariaLabel="Level"
                marks={[
                    <span key="l" data-testid="mark-l" style={{ left: "0%" }} />,
                    <span key="r" data-testid="mark-r" style={{ left: "100%" }} />,
                ]}
            />,
        );
        const overlay = document.querySelector(".ui-slider-marks");
        expect(overlay).not.toBeNull();
        // Decorative: hidden from the a11y tree so only the thumb is announced.
        expect(overlay?.getAttribute("aria-hidden")).toBe("true");
        expect(screen.getByTestId("mark-l").style.left).toBe("0%");
        expect(screen.getByTestId("mark-r").style.left).toBe("100%");
    });

    it("omits the marks overlay entirely when no marks are given", () => {
        render(<Slider value={0} min={0} max={6} step={1} ariaLabel="Level" />);
        expect(document.querySelector(".ui-slider-marks")).toBeNull();
    });
});
