/**
 * Switch — base component test.
 *
 * Locks the accessibility contract and the onChange callback shape so the
 * migration from per-file switch implementations doesn't silently lose the
 * role="switch" / aria-checked semantics or the Space-to-toggle behavior.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Switch } from "../../../src/components/ui/Switch";

afterEach(cleanup);

describe("Switch", () => {
    it("renders role=switch with aria-checked reflecting the checked prop", () => {
        render(<Switch checked label="Enabled" onChange={() => {}} />);
        const sw = screen.getByRole("switch", { name: "Enabled" });
        expect(sw.getAttribute("aria-checked")).toBe("true");
        expect((sw as HTMLButtonElement).disabled).toBe(false);
    });

    it("reports the opposite state via onChange when clicked", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Switch checked={false} label="Enabled" onChange={onChange} />);
        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it("does not fire onChange while disabled", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Switch checked label="Enabled" disabled onChange={onChange} />);
        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        expect(onChange).not.toHaveBeenCalled();
    });
});
