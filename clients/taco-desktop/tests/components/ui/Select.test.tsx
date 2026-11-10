import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormField } from "../../../src/components/ui/FormField";
import { Select } from "../../../src/components/ui/Select";

afterEach(cleanup);

describe("Select form contract", () => {
    it("forwards control attributes to the Radix trigger and preserves the label prop", () => {
        render(
            <Select
                id="protocol"
                aria-describedby="protocol-help"
                aria-invalid="grammar"
                label="Protocol picker"
                value="chat"
                options={["chat", "responses"]}
                onValueChange={vi.fn()}
            />,
        );
        const trigger = screen.getByRole("combobox", { name: "Protocol picker" });
        expect(trigger.id).toBe("protocol");
        expect(trigger.getAttribute("aria-describedby")).toBe("protocol-help");
        expect(trigger.getAttribute("aria-invalid")).toBe("grammar");
    });

    it("receives the FormField name and descriptions while retaining option selection", async () => {
        const user = userEvent.setup({ delay: null });
        const onValueChange = vi.fn();
        render(
            <>
                <span id="external-help">External help</span>
                <FormField label="Protocol" hint="Choose a protocol" error="Protocol required">
                    <Select
                        aria-describedby="external-help"
                        value="chat"
                        options={["chat", "responses"]}
                        onValueChange={onValueChange}
                    />
                </FormField>
            </>,
        );
        const trigger = screen.getByRole("combobox", { name: "Protocol" });
        expect(screen.getByLabelText("Protocol")).toBe(trigger);
        expect(trigger.getAttribute("aria-invalid")).toBe("true");
        const ids = trigger.getAttribute("aria-describedby")?.split(/\s+/);
        expect(ids?.map((id) => document.getElementById(id)?.textContent)).toEqual([
            "External help",
            "Choose a protocol",
            "Protocol required",
        ]);
        await user.click(trigger);
        await user.click(await screen.findByRole("option", { name: "responses" }));
        expect(onValueChange).toHaveBeenCalledWith("responses");
    });
});
