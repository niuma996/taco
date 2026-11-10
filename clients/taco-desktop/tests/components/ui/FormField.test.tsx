import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormField } from "../../../src/components/ui/FormField";
import { SecretInput } from "../../../src/components/ui/SecretInput";
import { TextInput } from "../../../src/components/ui/TextInput";

afterEach(cleanup);

describe("FormField", () => {
    it("names a compound group and links its messages without a native label", () => {
        const field = (error?: string) => (
            <FormField group label="Models" hint="Choose models" error={error}>
                <div>
                    <input aria-label="Model ID" />
                    <button type="button">Add model</button>
                </div>
            </FormField>
        );
        const { rerender } = render(field("Model required"));
        const group = screen.getByRole("group", { name: "Models" });
        const label = screen.getByText("Models");
        expect(label.tagName).toBe("SPAN");
        expect(label.classList.contains("ui-form-group-label")).toBe(true);
        expect(group.getAttribute("aria-labelledby")).toBe(label.id);
        expect(document.querySelector("label")).toBeNull();
        expect(group.getAttribute("aria-invalid")).toBe("true");
        const ids = group.getAttribute("aria-describedby")?.split(/\s+/);
        expect(ids?.map((id) => document.getElementById(id)?.textContent)).toEqual([
            "Choose models",
            "Model required",
        ]);
        expect(screen.getByRole("textbox", { name: "Model ID" }).hasAttribute("aria-invalid")).toBe(
            false,
        );
        const labelId = label.id;
        const groupId = group.id;
        expect(groupId).toBeTruthy();

        rerender(field());
        expect(screen.getByRole("group", { name: "Models" }).id).toBe(groupId);
        expect(label.id).toBe(labelId);
        expect(group.hasAttribute("aria-invalid")).toBe(false);
        expect(group.getAttribute("aria-describedby")).toBe(screen.getByText("Choose models").id);
    });

    it("preserves existing group roles, associations, refs and action semantics", async () => {
        const user = userEvent.setup({ delay: null });
        const ref = createRef<HTMLDivElement>();
        const onAction = vi.fn();
        render(
            <>
                <span id="existing-label">Available</span>
                <span id="existing-help">Existing help</span>
                <FormField
                    group
                    label="Models"
                    hint="Choose models"
                    action={
                        <button type="button" onClick={onAction}>
                            Fetch models
                        </button>
                    }
                >
                    <div
                        ref={ref}
                        id="models"
                        role="radiogroup"
                        aria-labelledby="existing-label"
                        aria-describedby="existing-help"
                    >
                        <input type="radio" aria-label="Model A" />
                    </div>
                </FormField>
            </>,
        );
        const group = screen.getByRole("radiogroup", { name: "Available Models" });
        expect(group.id).toBe("models");
        expect(ref.current).toBe(group);
        expect(group.getAttribute("aria-labelledby")?.split(/\s+/)).toEqual([
            "existing-label",
            screen.getByText("Models").id,
        ]);
        expect(group.getAttribute("aria-describedby")?.split(/\s+/)).toEqual([
            "existing-help",
            screen.getByText("Choose models").id,
        ]);
        expect(screen.getByRole("radio", { name: "Model A" })).toBeTruthy();
        await user.click(screen.getByText("Models"));
        expect(onAction).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Fetch models" }));
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(document.querySelector("label")).toBeNull();
    });

    it("generates unique control IDs that stay stable across rerenders", () => {
        const fields = (hint: string) => (
            <>
                <FormField label="First" hint={hint}>
                    <TextInput />
                </FormField>
                <FormField label="Second">
                    <input />
                </FormField>
            </>
        );
        const { rerender } = render(fields("Initial hint"));
        const first = screen.getByRole("textbox", { name: "First" });
        const second = screen.getByRole("textbox", { name: "Second" });
        expect(first.id).toBeTruthy();
        expect(second.id).toBeTruthy();
        expect(second.id).not.toBe(first.id);
        const firstId = first.id;
        const secondId = second.id;

        rerender(fields("Updated hint"));
        expect(screen.getByLabelText("First").id).toBe(firstId);
        expect(screen.getByLabelText("Second").id).toBe(secondId);
    });

    it("merges descriptions and clears field invalid state when the error is removed", () => {
        const field = (error?: string) => (
            <>
                <span id="external-help">External help</span>
                <FormField label="Account" hint="Account hint" error={error}>
                    <input id="account" aria-describedby="external-help" />
                </FormField>
            </>
        );
        const { rerender } = render(field("Account error"));
        const input = screen.getByRole("textbox", { name: "Account" });
        expect(input.id).toBe("account");
        const hint = screen.getByText("Account hint");
        const error = screen.getByRole("status");
        expect(hint.id).toBeTruthy();
        expect(error.id).toBeTruthy();
        expect(hint.id).not.toBe(error.id);
        expect(input.getAttribute("aria-describedby")?.split(/\s+/)).toEqual([
            "external-help",
            hint.id,
            error.id,
        ]);
        expect(input.getAttribute("aria-invalid")).toBe("true");

        const errorId = error.id;
        rerender(field());
        expect(input.getAttribute("aria-describedby")?.split(/\s+/)).toEqual([
            "external-help",
            hint.id,
        ]);
        expect(input.hasAttribute("aria-invalid")).toBe(false);
        expect(document.getElementById(errorId)).toBeNull();
    });

    it("preserves child validation and descriptions when the field has no messages", () => {
        render(
            <FormField label="Account">
                <input id="account" aria-describedby="external" aria-invalid="grammar" />
            </FormField>,
        );
        const input = screen.getByLabelText("Account");
        expect(input.getAttribute("aria-describedby")).toBe("external");
        expect(input.getAttribute("aria-invalid")).toBe("grammar");
    });

    it("focuses the native input from its label without replacing refs or input handlers", async () => {
        const user = userEvent.setup({ delay: null });
        const ref = createRef<HTMLInputElement>();
        const onChange = vi.fn();
        const onAction = vi.fn();
        render(
            <FormField
                label="Account"
                action={
                    <button type="button" onClick={onAction}>
                        Fetch account
                    </button>
                }
            >
                <TextInput ref={ref} name="account" onChange={onChange} />
            </FormField>,
        );
        const input = screen.getByRole("textbox");
        expect(ref.current).toBe(input);
        expect(input.getAttribute("name")).toBe("account");
        await user.click(screen.getByText("Account"));
        expect(document.activeElement).toBe(input);
        expect(onAction).not.toHaveBeenCalled();
        await user.keyboard("a");
        expect(onChange).toHaveBeenCalledTimes(1);
        const action = screen.getByRole("button", { name: "Fetch account" });
        expect(action.closest("label")).toBeNull();
        await user.click(action);
        expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("associates a SecretInput label and messages with the actual password control", async () => {
        const user = userEvent.setup({ delay: null });
        const ref = createRef<HTMLInputElement>();
        render(
            <FormField label="API key" hint="Keep private" error="Key required">
                <SecretInput ref={ref} name="apiKey" revealLabel="Reveal" hideLabel="Hide" />
            </FormField>,
        );
        const input = screen.getByLabelText("API key");
        expect(input.tagName).toBe("INPUT");
        expect(ref.current).toBe(input);
        expect(input.getAttribute("aria-invalid")).toBe("true");
        const descriptions = input.getAttribute("aria-describedby")?.split(/\s+/);
        expect(descriptions?.map((id) => document.getElementById(id)?.textContent)).toEqual([
            "Keep private",
            "Key required",
        ]);
        await user.click(screen.getByText("API key"));
        expect(document.activeElement).toBe(input);
        await user.type(input, "secret");
        await user.click(screen.getByRole("button", { name: "Reveal" }));
        expect(input.getAttribute("type")).toBe("text");
        expect((input as HTMLInputElement).value).toBe("secret");
        expect(screen.getByLabelText("API key")).toBe(input);
    });
});
