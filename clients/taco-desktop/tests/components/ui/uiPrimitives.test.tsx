/**
 * Base components in `src/components/ui/` — Modal, Select, Slider, Switch, Tag and
 * TextInput. Consolidated into one file so vitest pays the jsdom setup cost
 * once instead of six times.
 *
 * The contracts locked here:
 *  - Modal: Escape / scrim dismiss, `dismissible={false}`, focus restoration,
 *    aria-describedby wiring.
 *  - Select: Radix combobox roles + value reporting (native <select> is banned).
 *  - Slider: discrete steps, arrow-key stepping, commit semantics, marks overlay.
 *  - Switch: role="switch" / aria-checked / disabled behaviour. labelledBy names it from visible text and does not also set aria-label.
 *  - Tag: size / tone modifier classes, className merge, native span props.
 *  - TextInput: `.ui-input` class, className merge, React 19 ref-as-prop.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type RefObject, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Modal, type ModalProps } from "../../../src/components/ui/Modal";
import { Select } from "../../../src/components/ui/Select";
import { Slider } from "../../../src/components/ui/Slider";
import { Switch } from "../../../src/components/ui/Switch";
import { Tag } from "../../../src/components/ui/Tag";
import { TextInput } from "../../../src/components/ui/TextInput";

afterEach(cleanup);

// ─── Modal ──────────────────────────────────────────────────────────────────

function renderModal(props: Partial<ModalProps> = {}) {
    return render(
        <Modal open onClose={vi.fn()} title="Test dialog" {...props}>
            <p>body</p>
        </Modal>,
    );
}

describe("Modal", () => {
    it("calls onClose on Escape", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderModal({ onClose });
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when the scrim is clicked", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderModal({ onClose });
        await screen.findByRole("dialog");
        // Portal renders into document.body; the scrim is the backdrop sibling.
        const scrim = document.body.querySelector(".ui-modal-backdrop");
        expect(scrim).not.toBeNull();
        await user.click(scrim as Element);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ignores Escape and scrim clicks when dismissible is false", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        renderModal({ onClose, dismissible: false });
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        const scrim = document.body.querySelector(".ui-modal-backdrop");
        await user.click(scrim as Element);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("renders the actions row when actions are passed", async () => {
        renderModal({ actions: <button type="button">OK</button> });
        await screen.findByRole("dialog");
        expect(document.body.querySelector(".ui-modal-actions")).not.toBeNull();
    });

    it("renders no actions row when actions are omitted", async () => {
        renderModal();
        await screen.findByRole("dialog");
        expect(document.body.querySelector(".ui-modal-actions")).toBeNull();
    });

    it("links the description via aria-describedby when provided", async () => {
        renderModal({ description: "details" });
        const dialog = await screen.findByRole("dialog");
        const id = dialog.getAttribute("aria-describedby");
        expect(id).toBeTruthy();
        expect(document.getElementById(id as string)?.textContent).toBe("details");
    });

    it("omits aria-describedby when no description is provided", async () => {
        renderModal();
        const dialog = await screen.findByRole("dialog");
        expect(dialog.getAttribute("aria-describedby")).toBeNull();
    });

    it("restores focus to the previously focused element on close", async () => {
        const user = userEvent.setup();
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>
                        open
                    </button>
                    <Modal open={open} onClose={() => setOpen(false)} title="t">
                        <button type="button">inside</button>
                    </Modal>
                </>
            );
        }
        render(<Harness />);
        const trigger = screen.getByRole("button", { name: "open" });
        // happy-dom does not focus buttons on click — focus explicitly so
        // Radix records the trigger as the element to restore.
        trigger.focus();
        await user.click(trigger);
        const dialog = await screen.findByRole("dialog");
        expect(dialog.contains(document.activeElement)).toBe(true);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();
        // FocusScope restores focus in a setTimeout(0) after unmount.
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });
});

// ─── Select ─────────────────────────────────────────────────────────────────

const SELECT_OPTIONS = [
    { value: "ask", label: "Ask" },
    { value: "auto", label: "Auto" },
];

describe("Select", () => {
    it("renders a combobox trigger with the placeholder", () => {
        render(
            <Select
                value=""
                onValueChange={() => {}}
                options={SELECT_OPTIONS}
                placeholder="Pick"
            />,
        );
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
                options={SELECT_OPTIONS}
                label="Permission mode"
            />,
        );
        await user.click(screen.getByRole("combobox"));
        const option = await screen.findByRole("option", { name: "Auto" });
        await user.click(option);
        expect(onValueChange).toHaveBeenCalledWith("auto");
    });
});

// ─── Slider ─────────────────────────────────────────────────────────────────

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

// ─── Switch ─────────────────────────────────────────────────────────────────

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

    it("names itself from visible text without a second aria-label", () => {
        render(
            <>
                <span id="images">Image input</span>
                <Switch checked labelledBy="images" onChange={() => {}} />
            </>,
        );
        const sw = screen.getByRole("switch", { name: "Image input" });
        expect(sw.getAttribute("aria-labelledby")).toBe("images");
        expect(sw.hasAttribute("aria-label")).toBe(false);
    });
});

// ─── Tag ────────────────────────────────────────────────────────────────────

describe("Tag", () => {
    it("defaults to the md size with no tone modifier", () => {
        render(<Tag>stdio</Tag>);
        expect(screen.getByText("stdio").className).toBe("ui-tag ui-tag--md");
    });

    it("applies the sm size and strong tone modifiers", () => {
        render(
            <Tag size="sm" tone="strong">
                disabled
            </Tag>,
        );
        expect(screen.getByText("disabled").className).toBe("ui-tag ui-tag--sm ui-tag--strong");
    });

    it("merges an extra className last and passes native span props", () => {
        render(
            <Tag className="extra" title="hint">
                x
            </Tag>,
        );
        const el = screen.getByText("x");
        expect(el.className).toBe("ui-tag ui-tag--md extra");
        expect(el.getAttribute("title")).toBe("hint");
    });
});

// ─── TextInput ──────────────────────────────────────────────────────────────

describe("TextInput", () => {
    it("applies the ui-input class and passes native props", () => {
        render(<TextInput placeholder="Type here" />);
        const el = screen.getByPlaceholderText("Type here");
        expect(el.className).toContain("ui-input");
        expect((el as HTMLInputElement).type).toBe("text");
    });

    it("merges an extra className after ui-input", () => {
        render(<TextInput className="extra" />);
        expect((screen.getByRole("textbox") as HTMLInputElement).className).toBe("ui-input extra");
    });

    it("forwards the ref prop (React 19)", () => {
        const ref: RefObject<HTMLInputElement | null> = createRef<HTMLInputElement | null>();
        render(<TextInput ref={ref} />);
        expect(ref.current).toBeInstanceOf(HTMLInputElement);
    });

    it("fires onChange with the typed value", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<TextInput onChange={onChange} />);
        await user.type(screen.getByRole("textbox"), "abc");
        expect(onChange).toHaveBeenCalled();
        expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("abc");
    });
});
